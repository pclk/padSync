import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RESULT_BYTES, collectOutFiles } from "../bridge/lib";
import { POST as claimRoute } from "@/app/api/bridge/claim/route";
import { POST as createJobRoute } from "@/app/api/jobs/route";
import { DEFAULT_CONFIG } from "@/lib/ai-import";
import { getSendState, sendImport, setCurrentJob, startSend, subscribeSend } from "@/lib/import-send";
import { parsePayloadText } from "@/lib/schema";
import type { Sql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { configureAuthEnv, freshDb, req, sessionCookie } from "./helpers/env";

// Regressions for the problems found reviewing the AI import diff: double sends, holding every
// file in memory, figures crowding out padsync.json, older bridges taking import jobs, uploads
// lost on leaving the page, and prose with braces before the JSON.

let sql: Sql;
let session: string;

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
});

const store = new Map<string, string>();
beforeAll(() => {
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterAll(() => vi.unstubAllGlobals());

const routeFetch = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url, "https://pad.test");
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  const { PUT } = await import("@/app/api/jobs/[id]/inputs/route");
  const { POST: cancel } = await import("@/app/api/jobs/[id]/cancel/route");
  const m = /^\/api\/jobs\/([^/]+)\/(inputs|cancel)$/.exec(u.pathname);
  if (m?.[2] === "inputs") return PUT(req(u.pathname, { method: "PUT", body, session }), { params: Promise.resolve({ id: m[1] }) });
  if (m) return cancel(req(u.pathname, { method: "POST", session }), { params: Promise.resolve({ id: m[1] }) });
  return createJobRoute(req(u.pathname, { body, session }));
}) as typeof fetch;

describe("sending", () => {
  it("reads each file only when its turn comes", async () => {
    const order: string[] = [];
    const tracked = (async (url: string, init?: RequestInit) => {
      order.push(`${init?.method ?? "GET"} ${new URL(url, "https://x").pathname.split("/").pop()}`);
      return routeFetch(url, init);
    }) as typeof fetch;
    const att = (name: string) => ({ meta: { name, mime: "application/pdf" as const, kind: "pdf" as const, size: 6 }, base64: async () => (order.push(`read ${name}`), "AAAAAAAA") });
    await sendImport({ config: DEFAULT_CONFIG, attachments: [att("a"), att("b")], fetch: tracked });
    expect(order).toEqual(["POST jobs", "read a", "PUT inputs", "read b", "PUT inputs"]);
  });

  it("refuses a file whose size changed since it was attached", async () => {
    const att = { meta: { name: "a.pdf", mime: "application/pdf" as const, kind: "pdf" as const, size: 6 }, base64: async () => "AAAA" };
    await expect(sendImport({ config: DEFAULT_CONFIG, attachments: [att], fetch: routeFetch })).rejects.toThrow(/changed while it was being sent/);
  });

  it("a second tap while sending does nothing; the job id outlives the page", async () => {
    vi.stubGlobal("fetch", routeFetch);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const att = { meta: { name: "a.pdf", mime: "application/pdf" as const, kind: "pdf" as const, size: 3 }, base64: async () => (await gate, "AAAA") };
    let notified = 0;
    const unsub = subscribeSend(() => notified++);
    const first = startSend({ config: DEFAULT_CONFIG, attachments: [att] });
    const second = startSend({ config: DEFAULT_CONFIG, attachments: [att] });
    await second; // returns at once
    await vi.waitFor(() => expect(getSendState().jobId).toBeTruthy());
    expect(getSendState().progress).not.toBeNull();
    release();
    await first;
    unsub();
    expect(getSendState()).toMatchObject({ progress: null, error: null });
    expect(JSON.parse(store.get("padsync.import.jobId")!)).toBe(getSendState().jobId);
    expect(notified).toBeGreaterThan(1);
    const jobs = await sql.query<{ n: number }>(`select count(*)::int as n from jobs`);
    expect(Number(jobs[0].n)).toBe(1);
    setCurrentJob(null);
    expect(store.get("padsync.import.jobId")).toBe("null");
  });

  it("keeps a send's error for the page to show", async () => {
    vi.stubGlobal("fetch", (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch);
    await startSend({ config: DEFAULT_CONFIG, attachments: [{ meta: { name: "a", mime: "application/pdf", kind: "pdf", size: 3 }, base64: async () => "AAAA" }] });
    expect(getSendState().error).toMatch(/database is not set up/);
  });
});

describe("older bridges", () => {
  it("only bridges that declare import support get import jobs", async () => {
    const dev = await createDeviceToken(sql, "Mac", "pclk");
    const claim = async (features?: string[]) =>
      ((await (await claimRoute(req("/api/bridge/claim", { body: { agents: ["claude"], ...(features ? { features } : {}) }, bearer: dev.token }))).json()) as { job: { kind: string } | null }).job;
    await createJobRoute(req("/api/jobs", { body: { kind: "import", agent: "claude", question: "q", files: [{ path: "INSTRUCTIONS.md", mime: "text/markdown", text: "x" }] }, session }));
    expect(await claim()).toBeNull();
    expect(await claim(["something-else"])).toBeNull();
    await createJobRoute(req("/api/jobs", { body: { notebookId: "nb", sectionId: "s", agent: "claude", question: "q", context: "c" }, session }));
    expect((await claim())!.kind).toBe("ask"); // questions still flow to old bridges
    expect((await claim(["import"]))!.kind).toBe("import");
  });
});

describe("returned files", () => {
  it("collects padsync.json before a folder of figures that would use up the budget", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "padsync-out-")));
    const out = join(dir, "out");
    await mkdir(join(out, "figures"), { recursive: true });
    // "figures" sorts before "padsync.json"; together they are over the budget.
    await writeFile(join(out, "figures", "a.png"), Buffer.alloc(Math.floor((MAX_RESULT_BYTES * 3) / 4) - 10));
    await writeFile(join(out, "padsync.json"), JSON.stringify({ schemaVersion: 2, title: "x", sections: [{ blocks: [] }] }));
    const got = await collectOutFiles(out);
    expect(got.files.map((f) => f.path)).toContain("padsync.json");
    expect(got.skipped.join()).toMatch(/figures\/a\.png/);
  });
});

describe("extracting JSON", () => {
  it("finds the payload after prose that contains braces", () => {
    const json = JSON.stringify({ schemaVersion: 2, title: "T", sections: [{ blocks: [] }] });
    expect(parsePayloadText(`Use the {x} notation for sets. Here it is: ${json} Done.`).ok).toBe(true);
    expect(parsePayloadText("I used {braces} but no JSON").ok).toBe(false);
  });
});
