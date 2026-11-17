import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentCommand, cleanOptions } from "../bridge/lib.ts";
import { POST as claimRoute } from "@/app/api/bridge/claim/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/jobs/route";
import type { ToolKind, ToolState } from "@/ink/controller";
import type { Sql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { configureAuthEnv, freshDb, req, sessionCookie } from "./helpers/env";

// Per-question model / effort / web search, the iPad overlay canvas size, and the fixed-height
// tool rail.

vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));
vi.mock("@/lib/store", () => ({ putEntities: vi.fn(), newEntity: vi.fn(), logEvent: vi.fn(), setDeleted: vi.fn(), moveStrokes: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

describe("job options on the server", () => {
  let sql: Sql;
  let session: string;
  beforeEach(async () => {
    configureAuthEnv();
    ({ sql } = await freshDb());
    session = sessionCookie();
  });

  const ask = async (options?: unknown) => {
    const body = { notebookId: "nb", sectionId: "s1", agent: "codex", question: "q", ...(options === undefined ? {} : { options }) };
    const res = await createJobRoute(req("/api/jobs", { body, session }));
    return { status: res.status, body: (await res.json()) as { job?: { options: unknown }; error?: string } };
  };

  it("stores the options, lists them, and hands them to the bridge", async () => {
    const { status, body } = await ask({ model: "gpt-6-astra", effort: "max", webSearch: true });
    expect(status).toBe(201);
    expect(body.job?.options).toEqual({ model: "gpt-6-astra", effort: "max", webSearch: true });
    const list = (await (await listJobsRoute(req("/api/jobs?sectionId=s1", { session }))).json()) as { jobs: { options: unknown }[] };
    expect(list.jobs[0].options).toEqual({ model: "gpt-6-astra", effort: "max", webSearch: true });
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    const claim = await claimRoute(req("/api/bridge/claim", { body: { agents: ["codex"] }, bearer: token }));
    expect(((await claim.json()) as { job: { options: unknown } }).job.options).toEqual({ model: "gpt-6-astra", effort: "max", webSearch: true });
  });

  it("defaults to no options", async () => {
    expect((await ask()).body.job?.options).toEqual({});
  });

  it("rejects models that are not plain identifiers, unknown efforts and unknown keys", async () => {
    expect((await ask({ model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await ask({ model: "a b" })).status).toBe(400);
    expect((await ask({ effort: "extreme" })).status).toBe(400);
    expect((await ask({ sandbox: "danger-full-access" })).status).toBe(400);
  });
});

describe("agent command options", () => {
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("claude: --model and --effort, and no web tools unless asked", () => {
    const c = agentCommand("claude", {}, true, { model: "opus", effort: "high" });
    expect(after(c.args, "--model")).toBe("opus");
    expect(after(c.args, "--effort")).toBe("high");
    expect(after(c.args, "--tools")).toBe("Read");
    expect(c.args.slice(c.args.indexOf("--disallowedTools") + 1)).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash"]));
  });

  it("claude: web search allows WebSearch and WebFetch but still denies Bash and edits", () => {
    const c = agentCommand("claude", {}, false, { webSearch: true });
    expect(after(c.args, "--tools")).toBe("Read,WebSearch,WebFetch");
    const denied = c.args.slice(c.args.indexOf("--disallowedTools") + 1);
    expect(denied).not.toContain("WebSearch");
    expect(denied).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    expect(c.args).not.toContain("--model");
  });

  it("codex: --search before exec, model and reasoning effort, image still last", () => {
    const c = agentCommand("codex", {}, true, { model: "gpt-6-astra", effort: "ultra", webSearch: true });
    expect(c.args[0]).toBe("--search");
    expect(c.args[1]).toBe("exec");
    expect(after(c.args, "--model")).toBe("gpt-6-astra");
    expect(after(c.args, "-c")).toBe('model_reasoning_effort="ultra"');
    expect(c.args.slice(-2)).toEqual(["--image", "section.png"]);
    expect(c.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  it("drops anything the CLI would not accept", () => {
    expect(cleanOptions("claude", { effort: "ultra" }).effort).toBe("max");
    expect(cleanOptions("codex", { model: "-c sandbox=x", effort: "nope" })).toEqual({ model: undefined, effort: undefined, webSearch: false, allowEdits: false, allowCode: false });
    expect(cleanOptions("claude", { webSearch: "yes" as unknown as boolean }).webSearch).toBe(false);
    expect(agentCommand("codex", {}, false, { model: "--full-auto" }).args).not.toContain("--full-auto");
  });
});

describe("live overlay canvas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("CSS size matches the backing store, not 100vh", async () => {
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 1180, innerHeight: 740 });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    const { InkController } = await import("@/ink/controller");
    const c = new InkController("nb", tool("pen"), { onSelection() {}, onDragging() {}, onTextCreate() {} });
    const canvas = { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ({}) };
    c.attachLive(canvas as unknown as HTMLCanvasElement);
    expect(canvas.style).toEqual({ width: "1180px", height: "740px" });
    expect([canvas.width, canvas.height]).toEqual([2360, 1480]);
  });

  it("draws live ink relative to the overlay's own position", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("performance", { now: () => 0 });
    const { InkController } = await import("@/ink/controller");
    const c = new InkController("nb", tool("eraser"), { onSelection() {}, onDragging() {}, onTextCreate() {} });
    const transforms: number[][] = [];
    const ctx = { setTransform: (...a: number[]) => transforms.push(a), clearRect() {}, beginPath() {}, arc() {}, stroke() {} };
    c.attachLive({ width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 30 }) } as unknown as HTMLCanvasElement);
    const el = { getBoundingClientRect: () => ({ left: 50, top: 100 }), setPointerCapture() {} } as unknown as HTMLElement;
    c.down({ type: "pointerdown", pointerType: "pen", button: 0, pointerId: 1, clientX: 60, clientY: 110, pressure: 0.5, timeStamp: 0, preventDefault() {} } as unknown as PointerEvent, { id: "s", el, strokes: () => [] });
    frames.splice(0).forEach((f) => f(0));
    expect(transforms.at(-1)).toEqual([2, 0, 0, 2, 100, 140]);
  });
});

describe("tool rail", () => {
  const tools: ToolKind[] = ["pen", "highlighter", "eraser", "lasso", "text"];

  it("has the same slots in the same order for every tool", async () => {
    const { Toolbar } = await import("@/components/Toolbar");
    const rail = (kind: ToolKind) => {
      const html = renderToStaticMarkup(
        createElement(Toolbar, { title: "t", tool: tool(kind), setTool() {}, canUndo: true, canRedo: true, onUndo() {}, onRedo() {}, zoom: 1, onZoomReset() {}, panelOpen: false, onTogglePanel() {} }),
      );
      const aside = html.slice(html.indexOf("<aside"));
      // Structure only: the fixed size of each slot, ignoring colours, selection and visibility.
      // An empty colour slot is a span the size of a swatch.
      return aside.match(/<(button|span)[^>]*class="[^"]*\bh-\d+ w-\d+/g)!.map((m) => m.match(/h-\d+ w-\d+/)![0]);
    };
    const pen = rail("pen");
    expect(pen.length).toBeGreaterThan(10);
    for (const k of tools) expect(rail(k), k).toEqual(pen);
  });

  it("hides, rather than removes, the colours and sizes a tool does not use", async () => {
    const { Toolbar } = await import("@/components/Toolbar");
    const html = renderToStaticMarkup(
      createElement(Toolbar, { title: "t", tool: tool("lasso"), setTool() {}, canUndo: false, canRedo: false, onUndo() {}, onRedo() {}, zoom: 1, onZoomReset() {}, panelOpen: false, onTogglePanel() {} }),
    );
    expect(html.match(/class="[^"]*\binvisible\b/g)).toHaveLength(2);
  });
});

function tool(kind: ToolKind): ToolState {
  return { kind, penColor: "#111827", penSize: 2.2, hlColor: "#facc15", hlSize: 14, eraserSize: 12 };
}
