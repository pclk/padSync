import { beforeEach, describe, expect, it } from "vitest";
import { POST as claimRoute } from "@/app/api/bridge/claim/route";
import { GET as bridgeInput } from "@/app/api/bridge/jobs/[id]/inputs/route";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { PUT as putInput } from "@/app/api/jobs/[id]/inputs/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/jobs/route";
import { DEFAULT_CONFIG } from "@/lib/ai-import";
import { SendError, sendImport } from "@/lib/import-send";
import { PART_CHARS } from "@/lib/uploads";
import { migrate, type Sql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// AI import jobs on the server: kind "import", the upload manifest, parts, queueing once complete,
// bridge-only reads, and deleting the parts when the job ends. Plus sendImport against the real
// routes (retry, cancel, failure).

let sql: Sql;
let session: string;
let bridge: { token: string; id: string };
let other: { token: string; id: string };

const b64 = (n: number, c = "A") => c.repeat(n);
const importBody = (uploads: { path: string; mime?: string; size: number; parts?: number }[], over: Record<string, unknown> = {}) => ({
  kind: "import",
  agent: "claude",
  question: "Make notes",
  files: [{ path: "INSTRUCTIONS.md", mime: "text/markdown", text: "# How" }],
  uploads: uploads.map((u) => ({ mime: "application/pdf", parts: Math.max(1, Math.ceil(u.size / PART_CHARS)), ...u })),
  options: { allowEdits: true },
  ...over,
});

async function create(body: unknown) {
  const res = await createJobRoute(req("/api/jobs", { body, session }));
  return { status: res.status, body: (await res.json()) as { job: { id: string; status: string; kind: string; uploads: unknown[] }; error?: string } };
}
async function put(id: string, path: string, part: number, data: string, s: string | false = session) {
  const res = await putInput(req(`/api/jobs/${id}/inputs`, { method: "PUT", body: { path, part, data }, session: s }), params({ id }));
  return { status: res.status, body: (await res.json()) as { status?: string; received?: number; expected?: number; error?: string } };
}
async function claim(b = bridge) {
  const res = await claimRoute(req("/api/bridge/claim", { body: { agents: ["claude"], features: ["import"] }, bearer: b.token }));
  return ((await res.json()) as { job: null | { id: string; kind: string; uploads: { path: string; size: number; parts: number }[]; files: { path: string }[] } }).job;
}
async function fetchPart(id: string, path: string, part: number, b = bridge) {
  const res = await bridgeInput(req(`/api/bridge/jobs/${id}/inputs?path=${encodeURIComponent(path)}&part=${part}`, { bearer: b.token }), params({ id }));
  return { status: res.status, body: (await res.json()) as { data?: string; error?: string } };
}
const parts = async (id: string) => Number((await sql.query<{ n: number }>(`select count(*)::int as n from job_inputs where job_id = $1`, [id]))[0].n);
const jobStatus = async (id: string) => ((await (await getJobRoute(req(`/api/jobs/${id}`, { session }), params({ id }))).json()) as { job: { status: string } }).job.status;

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
  const a = await createDeviceToken(sql, "Mac", "pclk");
  const o = await createDeviceToken(sql, "Other", "pclk");
  bridge = { token: a.token, id: a.record.id };
  other = { token: o.token, id: o.record.id };
});

describe("creating import jobs", () => {
  it("starts in uploading and is not claimable until every part is in", async () => {
    const { status, body } = await create(importBody([{ path: "lectures/01-a.pdf", size: PART_CHARS + 8 }]));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "import", status: "uploading", uploads: [{ path: "lectures/01-a.pdf", size: PART_CHARS + 8, parts: 2 }] });
    const id = body.job.id;
    expect(await claim()).toBeNull();
    expect((await put(id, "lectures/01-a.pdf", 0, b64(PART_CHARS))).body).toMatchObject({ status: "uploading", received: 1, expected: 2 });
    expect(await claim()).toBeNull();
    expect((await put(id, "lectures/01-a.pdf", 1, b64(8))).body).toMatchObject({ status: "queued", received: 2 });
    const job = await claim();
    expect(job).toMatchObject({ id, kind: "import", uploads: [{ path: "lectures/01-a.pdf", parts: 2 }], files: [{ path: "INSTRUCTIONS.md" }] });
  });

  it("queues at once with no uploads, and lists imports", async () => {
    const { body } = await create(importBody([]));
    expect(body.job.status).toBe("queued");
    const list = await listJobsRoute(req("/api/jobs?kind=import", { session }));
    expect(((await list.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toEqual([body.job.id]);
  });

  it("rejects bad manifests", async () => {
    const bad = async (body: unknown, re: RegExp) => {
      const r = await create(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(re);
    };
    await bad(importBody([{ path: "../evil.pdf", size: 8 }]), /path/);
    await bad(importBody([{ path: "lectures/a/b/c.pdf", size: 8 }]), /path/);
    await bad(importBody([{ path: "lectures/a.pdf", size: 10 }]), /multiple of 4/);
    await bad(importBody([{ path: "lectures/a.pdf", size: 8, parts: 2 }]), /parts/);
    await bad(importBody([{ path: "lectures/a.exe", mime: "application/x-msdownload", size: 8 }]), /mime/);
    await bad(importBody([{ path: "INSTRUCTIONS.md", mime: "text/markdown", size: 8 }]), /unique/);
    await bad(importBody([{ path: "lectures/a.pdf", size: 40_000_000 }]), /at most/);
    await bad(importBody(Array.from({ length: 4 }, (_, i) => ({ path: `lectures/${i}.pdf`, size: 16_000_000 }))), /total/);
    await bad({ ...importBody([{ path: "lectures/a.pdf", size: 8 }]), kind: "ask", notebookId: "nb", sectionId: "s" }, /only imports/);
    await bad({ agent: "claude", sectionId: null, question: "q" }, /notebookId: required/);
  });
});

describe("parts", () => {
  let id: string;
  beforeEach(async () => {
    id = (await create(importBody([{ path: "lectures/01-a.pdf", size: 12 }, { path: "lectures/02-b.png", mime: "image/png", size: 8 }]))).body.job.id;
  });

  it("checks path, part number, exact length and base64, and needs a session", async () => {
    expect((await put(id, "lectures/zz.pdf", 0, b64(12))).status).toBe(400);
    expect((await put(id, "lectures/01-a.pdf", 1, b64(12))).status).toBe(400);
    expect((await put(id, "lectures/01-a.pdf", 0, b64(8))).body.error).toMatch(/must be 12 characters, got 8/);
    expect((await put(id, "lectures/01-a.pdf", 0, "!!!!!!!!!!!!")).status).toBe(400);
    expect((await put(id, "lectures/01-a.pdf", 0, b64(12), false)).status).toBe(401);
    expect((await put("job_nope", "lectures/01-a.pdf", 0, b64(12))).status).toBe(404);
    expect(await parts(id)).toBe(0);
  });

  it("accepts a retried part (overwrite) and refuses parts once queued or cancelled", async () => {
    await put(id, "lectures/01-a.pdf", 0, b64(12, "B"));
    expect((await put(id, "lectures/01-a.pdf", 0, b64(12, "C"))).body.received).toBe(1);
    expect((await put(id, "lectures/02-b.png", 0, b64(8))).body.status).toBe("queued");
    expect((await put(id, "lectures/02-b.png", 0, b64(8))).status).toBe(409);
    const job = await claim();
    expect((await fetchPart(job!.id, "lectures/01-a.pdf", 0)).body.data).toBe(b64(12, "C"));
  });

  it("only the claiming device can read parts, only while running", async () => {
    await put(id, "lectures/01-a.pdf", 0, b64(12));
    expect((await fetchPart(id, "lectures/01-a.pdf", 0)).status).toBe(404); // still uploading
    await put(id, "lectures/02-b.png", 0, b64(8));
    expect((await fetchPart(id, "lectures/01-a.pdf", 0)).status).toBe(404); // queued, not claimed
    await claim();
    expect((await fetchPart(id, "lectures/01-a.pdf", 0, other)).status).toBe(404);
    expect((await fetchPart(id, "lectures/01-a.pdf", 0)).body.data).toBe(b64(12));
    expect((await fetchPart(id, "lectures/01-a.pdf", 1)).status).toBe(404);
    expect((await fetchPart(id, "x", -1)).status).toBe(400);
    const anon = await bridgeInput(req(`/api/bridge/jobs/${id}/inputs?path=lectures/01-a.pdf&part=0`, { session }), params({ id }));
    expect(anon.status).toBe(401); // a browser session is not a device token
  });

  it("deletes the parts when the job finishes, fails or is cancelled", async () => {
    await put(id, "lectures/01-a.pdf", 0, b64(12));
    await put(id, "lectures/02-b.png", 0, b64(8));
    await claim();
    expect(await parts(id)).toBe(2);
    await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body: { output: "half" }, bearer: bridge.token }), params({ id }));
    expect(await parts(id)).toBe(2); // progress keeps them
    await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body: { status: "done", output: "ok" }, bearer: bridge.token }), params({ id }));
    expect(await parts(id)).toBe(0);

    const id2 = (await create(importBody([{ path: "lectures/01-a.pdf", size: 12 }]))).body.job.id;
    await put(id2, "lectures/01-a.pdf", 0, b64(12));
    await claim();
    await bridgeUpdate(req(`/api/bridge/jobs/${id2}`, { body: { status: "error", error: "x" }, bearer: bridge.token }), params({ id: id2 }));
    expect(await parts(id2)).toBe(0);
  });

  it("cancelling mid-upload deletes the parts and stops further parts", async () => {
    await put(id, "lectures/01-a.pdf", 0, b64(12));
    const res = await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }));
    expect(res.status).toBe(200);
    expect(await jobStatus(id)).toBe("cancelled");
    expect(await parts(id)).toBe(0);
    expect((await put(id, "lectures/02-b.png", 0, b64(8))).status).toBe(409);
  });

  it("migrate cancels imports abandoned mid-upload and drops orphaned parts", async () => {
    await put(id, "lectures/01-a.pdf", 0, b64(12));
    await sql.query(`update jobs set updated_at = now() - interval '2 days' where id = $1`, [id]);
    await sql.query(`insert into job_inputs (job_id, path, part, data) values ('job_gone', 'x', 0, 'AAAA')`);
    await migrate(sql);
    expect(await jobStatus(id)).toBe("cancelled");
    expect(Number((await sql.query<{ n: number }>(`select count(*)::int as n from job_inputs`))[0].n)).toBe(0);
  });
});

describe("sendImport against the routes", () => {
  const calls: string[] = [];
  let failNext = 0;
  const routeFetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "https://pad.test");
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    init.signal?.throwIfAborted();
    const m = /^\/api\/jobs\/([^/]+)\/(inputs|cancel)$/.exec(u.pathname);
    if (m && m[2] === "inputs") {
      if (failNext > 0) {
        failNext--;
        return Response.json({ error: "boom" }, { status: 502 });
      }
      return putInput(req(u.pathname, { method: "PUT", body, session }), params({ id: m[1] }));
    }
    if (m) return cancelRoute(req(u.pathname, { method: "POST", session }), params({ id: m[1] }));
    return createJobRoute(req(u.pathname, { body, session }));
  }) as typeof fetch;
  const att = (name: string, base64: string) => ({ meta: { name, mime: "application/pdf" as const, kind: "pdf" as const, size: (base64.length * 3) / 4 }, base64: async () => base64 });

  beforeEach(() => {
    calls.length = 0;
    failNext = 0;
  });

  it("uploads every part in order and the job ends up queued", async () => {
    const progress: number[] = [];
    const r = await sendImport({ config: DEFAULT_CONFIG, attachments: [att("L1.pdf", b64(PART_CHARS + 4)), att("L2.pdf", b64(8, "B"))], fetch: routeFetch, onProgress: (p) => p.phase === "uploading" && progress.push(p.sent) });
    expect(r.status).toBe("queued");
    expect(await jobStatus(r.jobId)).toBe("queued");
    expect(calls).toEqual(["POST /api/jobs", ...Array(3).fill(`PUT /api/jobs/${r.jobId}/inputs`)]);
    expect(progress).toEqual([PART_CHARS, PART_CHARS + 4, PART_CHARS + 12]);
    const job = await claim();
    expect(job!.uploads.map((u) => u.path)).toEqual(["lectures/01-l1.pdf", "lectures/02-l2.pdf"]);
  });

  it("retries a part after a server error", async () => {
    failNext = 2;
    const r = await sendImport({ config: DEFAULT_CONFIG, attachments: [att("L1.pdf", b64(8))], fetch: routeFetch });
    expect(r.status).toBe("queued");
    expect(calls.filter((c) => c.includes("inputs"))).toHaveLength(3);
  });

  it("gives up after retries and cancels the job, leaving no parts", async () => {
    failNext = 99;
    let jobId = "";
    await expect(sendImport({ config: DEFAULT_CONFIG, attachments: [att("L1.pdf", b64(8)), att("L2.pdf", b64(8))], fetch: routeFetch, onJob: (id) => (jobId = id) })).rejects.toThrow(/Uploading L1\.pdf failed \(502\)/);
    expect(await jobStatus(jobId)).toBe("cancelled");
    expect(await parts(jobId)).toBe(0);
  });

  it("cancel (abort) mid-upload cancels the job on the server", async () => {
    const ac = new AbortController();
    let jobId = "";
    const p = sendImport({
      config: DEFAULT_CONFIG,
      attachments: [att("L1.pdf", b64(PART_CHARS * 2))],
      fetch: routeFetch,
      signal: ac.signal,
      onJob: (id) => (jobId = id),
      onProgress: (pr) => pr.phase === "uploading" && ac.abort(),
    });
    await expect(p).rejects.toThrow(SendError);
    await expect(p).rejects.toThrow(/Cancelled/);
    expect(await jobStatus(jobId)).toBe("cancelled");
    expect(await parts(jobId)).toBe(0);
  });

  it("explains a missing sign-in and refuses an empty list", async () => {
    const noAuth = (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as unknown as typeof fetch;
    await expect(sendImport({ config: DEFAULT_CONFIG, attachments: [att("L1.pdf", b64(8))], fetch: noAuth })).rejects.toThrow(/Sign in on the Settings page/);
    await expect(sendImport({ config: DEFAULT_CONFIG, attachments: [], fetch: routeFetch })).rejects.toThrow(/Attach at least one file/);
  });
});
