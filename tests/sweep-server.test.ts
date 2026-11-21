import { beforeEach, describe, expect, it } from "vitest";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { POST as createJobRoute } from "@/app/api/jobs/route";
import { POST as sync } from "@/app/api/sync/route";
import { migrate, type Sql } from "@/server/db";
import { claimJob } from "@/server/jobs";
import { createDeviceToken, verifyDeviceToken } from "@/server/tokens";
import { PNG_DATA_URL, configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// Optimization sweep, server side: sync round-trip shape, one-query token checks, job storage
// reclaim and batched migrations.

let sql: Sql;
let session: string;

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
});

const hlc = (wall: number, count = 0, dev = "dev") => `${String(wall).padStart(13, "0")}-${String(count).padStart(4, "0")}-${dev}`;
const ent = (id: string, h: string, data: Record<string, unknown> = {}, deleted: 0 | 1 = 0) => ({ id, kind: "stroke", notebookId: "nb", parentId: "s1", data, hlc: h, deleted });

async function push(changes: unknown[], since = 0) {
  const res = await sync(req("/api/sync", { body: { since, changes, events: [] }, session }));
  return { status: res.status, body: (await res.json()) as { changes: { id: string; hlc: string; data: Record<string, unknown> }[]; cursor: number; more: boolean } };
}

describe("sync route", () => {
  it("accepts a batch with the same id twice and keeps the newest", async () => {
    const { status } = await push([ent("a", hlc(2), { v: 2 }), ent("a", hlc(1), { v: 1 }), ent("a", hlc(3), { v: 3 })]);
    expect(status).toBe(200);
    const rows = await sql.query<{ hlc: string; data: { v: number } }>(`select hlc, data from entities where id = 'a'`);
    expect(rows).toEqual([{ hlc: hlc(3), data: { v: 3 } }]);
  });

  it("does not echo the caller's own writes, but still advances the cursor past them", async () => {
    const { body } = await push([ent("a", hlc(1)), ent("b", hlc(1))]);
    expect(body.changes).toEqual([]);
    expect(body.cursor).toBeGreaterThan(0);
    const again = await push([], body.cursor);
    expect(again.body.changes).toEqual([]);
  });

  it("still delivers other rows in the same page", async () => {
    await push([ent("other", hlc(1))]);
    const { body } = await push([ent("mine", hlc(1))], 0);
    expect(body.changes.map((c) => c.id)).toEqual(["other"]);
  });

  it("returns the winning server version when a push loses, even behind the cursor", async () => {
    const first = await push([ent("a", hlc(5), { v: "server" })]);
    const { body } = await push([ent("a", hlc(4), { v: "stale" })], first.body.cursor);
    expect(body.changes).toEqual([expect.objectContaining({ id: "a", hlc: hlc(5), data: { v: "server" } })]);
    const rows = await sql.query<{ data: { v: string } }>(`select data from entities where id = 'a'`);
    expect(rows[0].data.v).toBe("server");
  });

  it("an identical re-push is neither applied nor reported", async () => {
    const first = await push([ent("a", hlc(5))]);
    const seq = (await sql.query<{ seq: string }>(`select seq from entities where id = 'a'`))[0].seq;
    const { body } = await push([ent("a", hlc(5))], first.body.cursor);
    expect(body.changes).toEqual([]);
    expect((await sql.query<{ seq: string }>(`select seq from entities where id = 'a'`))[0].seq).toBe(seq);
  });

  it("orders hlc bytewise, the way the client compares strings", async () => {
    // Under a natural-language collation, uppercase vs lowercase device ids can order differently.
    const lower = hlc(7, 0, "a"), upper = hlc(7, 0, "B");
    expect(lower > upper).toBe(true); // JS: 'a' (0x61) > 'B' (0x42)
    await push([ent("x", upper, { v: "B" })]);
    await push([ent("x", lower, { v: "a" })]);
    const rows = await sql.query<{ data: { v: string } }>(`select data from entities where id = 'x'`);
    expect(rows[0].data.v).toBe("a");
  });
});

describe("device token verification", () => {
  it("is a single query, including the last-used refresh", async () => {
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    let n = 0;
    const counting: Sql = { query: (t, p) => (n++, sql.query(t, p)) };
    expect(await verifyDeviceToken(counting, token, { hostname: "mbp" })).not.toBeNull();
    expect(n).toBe(1);
    const row = (await sql.query<{ last_used_at: Date | null; last_seen_info: unknown }>(`select last_used_at, last_seen_info from device_tokens`))[0];
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_seen_info).toEqual({ hostname: "mbp" });
  });

  it("keeps last_seen_info when no info is sent", async () => {
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    await verifyDeviceToken(sql, token, { hostname: "mbp" });
    await verifyDeviceToken(sql, token);
    expect((await sql.query<{ i: unknown }>(`select last_seen_info as i from device_tokens`))[0].i).toEqual({ hostname: "mbp" });
  });

  it("rejects revoked tokens in the same query", async () => {
    const { token, record } = await createDeviceToken(sql, "Mac", "pclk");
    await sql.query(`update device_tokens set revoked_at = now() where id = $1`, [record.id]);
    expect(await verifyDeviceToken(sql, token)).toBeNull();
  });
});

describe("job storage", () => {
  async function runningJob() {
    const res = await createJobRoute(req("/api/jobs", { body: { notebookId: "nb", sectionId: "s1", agent: "claude", question: "q", context: "ctx", image: PNG_DATA_URL }, session }));
    const { job } = (await res.json()) as { job: { id: string } };
    const { token, record } = await createDeviceToken(sql, "Mac", "pclk");
    return { id: job.id, token, device: record.id };
  }
  const stored = async (id: string) => (await sql.query<{ image: string | null; context: string }>(`select image, context from jobs where id = $1`, [id]))[0];

  it("keeps image and context while running and drops them when done", async () => {
    const j = await runningJob();
    const claimed = await claimJob(sql, j.device, ["claude"]);
    expect(claimed?.image).toBe(PNG_DATA_URL);
    await bridgeUpdate(req(`/api/bridge/jobs/${j.id}`, { body: { append: "hi" }, bearer: j.token }), params({ id: j.id }));
    expect((await stored(j.id)).image).toBe(PNG_DATA_URL);
    await bridgeUpdate(req(`/api/bridge/jobs/${j.id}`, { body: { status: "done" }, bearer: j.token }), params({ id: j.id }));
    expect(await stored(j.id)).toEqual({ image: null, context: "" });
  });

  it("drops them when the job errors", async () => {
    const j = await runningJob();
    await claimJob(sql, j.device, ["claude"]);
    await bridgeUpdate(req(`/api/bridge/jobs/${j.id}`, { body: { status: "error", error: "boom" }, bearer: j.token }), params({ id: j.id }));
    expect(await stored(j.id)).toEqual({ image: null, context: "" });
  });

  it("drops them when the job is cancelled", async () => {
    const j = await runningJob();
    await cancelRoute(req(`/api/jobs/${j.id}/cancel`, { method: "POST", session }), params({ id: j.id }));
    expect(await stored(j.id)).toEqual({ image: null, context: "" });
  });

  it("migrations clear jobs that finished before this change", async () => {
    const j = await runningJob();
    await sql.query(`update jobs set status = 'done' where id = $1`, [j.id]);
    await migrate(sql);
    expect(await stored(j.id)).toEqual({ image: null, context: "" });
  });
});

describe("migrations", () => {
  it("use one batch when the driver supports it, and are idempotent", async () => {
    const batches: string[][] = [];
    let singles = 0;
    const batching: Sql = {
      query: (t, p) => (singles++, sql.query(t, p)),
      batch: async (texts) => {
        batches.push(texts);
        for (const t of texts) await sql.query(t);
      },
    };
    await sql.query("delete from schema_state"); // the first run below migrates, the second finds it current
    await migrate(batching);
    await migrate(batching);
    expect(batches).toHaveLength(2);
    expect(batches[0].length).toBeGreaterThan(5);
    // The schema is current by then: only housekeeping, no DDL (see migrate-no-ddl.test.ts).
    expect(batches[1].filter((t) => /^\s*(alter|create)\b/i.test(t))).toEqual([]);
    expect(singles).toBe(2); // one schema check per run, in front of its batch
  });
});
