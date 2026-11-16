import { beforeEach, describe, expect, it } from "vitest";
import { POST as claimRoute } from "@/app/api/bridge/claim/route";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/jobs/route";
import type { Sql } from "@/server/db";
import { MAX_OUTPUT, STALE_AFTER_S, claimJob, createJob } from "@/server/jobs";
import { createDeviceToken } from "@/server/tokens";
import { PNG_DATA_URL, configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

let sql: Sql;
let session: string;
let bridgeA: { token: string; id: string };
let bridgeB: { token: string; id: string };

const baseJob = { notebookId: "nb1", sectionId: "s1", agent: "claude", question: "Is line 3 right?", context: "## Q1\nEvaluate $x$", image: PNG_DATA_URL };

async function ask(overrides: Record<string, unknown> = {}) {
  const res = await createJobRoute(req("/api/jobs", { body: { ...baseJob, ...overrides }, session }));
  return { res, body: (await res.json()) as { job: { id: string; status: string }; error?: string } };
}

async function claimAs(b: { token: string }, agents = ["claude", "codex"]) {
  const res = await claimRoute(req("/api/bridge/claim", { body: { agents, info: { hostname: "mbp" } }, bearer: b.token }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { job: null | { id: string; question: string; image: string | null; context: string; agent: string } }).job;
}

async function update(b: { token: string }, id: string, body: Record<string, unknown>) {
  const res = await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body, bearer: b.token }), params({ id }));
  return { status: res.status, body: (await res.json()) as { status?: string; cancelled?: boolean; error?: string } };
}

async function fetchJob(id: string) {
  const res = await getJobRoute(req(`/api/jobs/${id}`, { session }), params({ id }));
  return ((await res.json()) as { job: { status: string; output: string; error: string | null; finishedAt: string | null } }).job;
}

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
  const a = await createDeviceToken(sql, "A", "pclk");
  const b = await createDeviceToken(sql, "B", "pclk");
  bridgeA = { token: a.token, id: a.record.id };
  bridgeB = { token: b.token, id: b.record.id };
});

describe("creating jobs", () => {
  it("queues a valid job", async () => {
    const { res, body } = await ask();
    expect(res.status).toBe(201);
    expect(body.job.status).toBe("queued");
  });

  it.each([
    [{ agent: "gpt" }, "unknown agent"],
    [{ question: "   " }, "blank question"],
    [{ question: "x".repeat(4001) }, "question too long"],
    [{ image: "data:image/svg+xml;base64,PHN2Zz4=" }, "non-PNG image"],
    [{ image: "https://evil.test/x.png" }, "remote image URL"],
    [{ image: "data:image/png;base64,<script>" }, "non-base64 payload"],
    [{ notebookId: "" }, "missing notebook"],
  ])("rejects %j (%s)", async (o, why) => {
    expect((await ask(o)).res.status, why).toBe(400);
  });

  it("allows a job without an image", async () => {
    expect((await ask({ image: null })).res.status).toBe(201);
  });

  it("listing omits image and context", async () => {
    await ask();
    const res = await listJobsRoute(req("/api/jobs?sectionId=s1", { session }));
    const text = await res.text();
    expect(text).not.toContain("base64");
    expect(text).not.toContain("Evaluate");
    expect(JSON.parse(text).jobs).toHaveLength(1);
  });
});

describe("claiming", () => {
  it("hands out the oldest job first, with its image and context", async () => {
    const first = (await ask({ question: "first" })).body.job.id;
    await ask({ question: "second" });
    const job = await claimAs(bridgeA);
    expect(job?.id).toBe(first);
    expect(job?.image).toBe(PNG_DATA_URL);
    expect(job?.context).toContain("Evaluate");
  });

  it("never gives the same job to two bridges", async () => {
    await ask();
    const [a, b] = await Promise.all([claimAs(bridgeA), claimAs(bridgeB)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await claimAs(bridgeA)).toBeNull();
  });

  it("only claims agents the bridge can run", async () => {
    await ask({ agent: "codex" });
    expect(await claimAs(bridgeA, ["claude"])).toBeNull();
    expect((await claimAs(bridgeA, ["codex"]))?.agent).toBe("codex");
  });

  it("reclaims a running job whose bridge went quiet, resetting its output", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    await update(bridgeA, id, { output: "half an answer" });
    await sql.query(`update jobs set updated_at = now() - make_interval(secs => $1) where id = $2`, [STALE_AFTER_S + 5, id]);
    const again = await claimAs(bridgeB);
    expect(again?.id).toBe(id);
    expect((await fetchJob(id)).output).toBe("");
    // The original bridge has lost the job.
    expect((await update(bridgeA, id, { output: "late" })).status).toBe(409);
  });

  it("does not reclaim an active running job", async () => {
    await ask();
    await claimAs(bridgeA);
    expect(await claimAs(bridgeB)).toBeNull();
  });

  it("ignores cancelled and finished jobs", async () => {
    const id = (await ask()).body.job.id;
    await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }));
    expect(await claimAs(bridgeA)).toBeNull();
  });

  it("claimJob with no agents claims nothing", async () => {
    await createJob(sql, { ...baseJob, agent: "claude", sectionId: "s1", context: "", image: null });
    expect(await claimJob(sql, bridgeA.id, [])).toBeNull();
  });
});

describe("bridge updates", () => {
  it("streams output then completes", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    expect((await update(bridgeA, id, { output: "Line 3 is" })).body).toEqual({ status: "running", cancelled: false });
    expect((await update(bridgeA, id, { append: " wrong." })).status).toBe(200);
    expect((await update(bridgeA, id, { status: "done" })).body.status).toBe("done");
    const job = await fetchJob(id);
    expect(job.output).toBe("Line 3 is wrong.");
    expect(job.status).toBe("done");
    expect(job.finishedAt).not.toBeNull();
  });

  it("an empty update is a heartbeat: keeps the job fresh, changes nothing else", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    await update(bridgeA, id, { output: "so far" });
    await sql.query(`update jobs set updated_at = now() - make_interval(secs => $1) where id = $2`, [STALE_AFTER_S - 1, id]);
    expect((await update(bridgeA, id, {})).body).toEqual({ status: "running", cancelled: false });
    await sql.query(`update jobs set updated_at = updated_at - interval '2 seconds' where id = $1`, [id]);
    expect(await claimAs(bridgeB)).toBeNull(); // would have been reclaimed without the heartbeat
    expect((await fetchJob(id)).output).toBe("so far");
  });

  it("records errors", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    await update(bridgeA, id, { status: "error", error: "claude not logged in" });
    const job = await fetchJob(id);
    expect(job.status).toBe("error");
    expect(job.error).toBe("claude not logged in");
  });

  it("only the claiming bridge may write", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    expect((await update(bridgeB, id, { output: "hijack" })).status).toBe(409);
    expect((await fetchJob(id)).output).toBe("");
  });

  it("cannot write to an unclaimed or finished job", async () => {
    const id = (await ask()).body.job.id;
    expect((await update(bridgeA, id, { output: "x" })).status).toBe(409);
    await claimAs(bridgeA);
    await update(bridgeA, id, { status: "done", output: "final" });
    expect((await update(bridgeA, id, { output: "rewrite" })).status).toBe(409);
    expect((await fetchJob(id)).output).toBe("final");
  });

  it("tells the bridge when the user cancelled", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    const res = await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }));
    expect(res.status).toBe(200);
    expect((await update(bridgeA, id, { output: "more" })).body).toEqual({ status: "cancelled", cancelled: true });
    expect((await fetchJob(id)).status).toBe("cancelled");
  });

  it("cancelling twice is a conflict", async () => {
    const id = (await ask()).body.job.id;
    expect((await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }))).status).toBe(200);
    expect((await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }))).status).toBe(409);
  });

  it("caps output size", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    await update(bridgeA, id, { output: "a".repeat(MAX_OUTPUT) });
    await update(bridgeA, id, { append: "overflow" });
    expect((await fetchJob(id)).output).toHaveLength(MAX_OUTPUT);
  });

  it("rejects append and output together, and oversize payloads", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    expect((await update(bridgeA, id, { append: "a", output: "b" })).status).toBe(400);
    expect((await update(bridgeA, id, { output: "a".repeat(MAX_OUTPUT + 1) })).status).toBe(400);
    expect((await update(bridgeA, id, { status: "running" })).status).toBe(400);
  });

  it("a revoked bridge is cut off mid-job", async () => {
    const id = (await ask()).body.job.id;
    await claimAs(bridgeA);
    await sql.query(`update device_tokens set revoked_at = now() where id = $1`, [bridgeA.id]);
    const res = await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body: { output: "x" }, bearer: bridgeA.token }), params({ id }));
    expect(res.status).toBe(401);
  });
});
