import { afterEach, describe, expect, it } from "vitest";
import { buildDebugReport } from "@/lib/debug-report";
import { measureDom } from "@/lib/perf-watch";
import { beginSyncDebugRequest, countDebug, observeDebug, recordDebugError, recordDebugSample, recordInputAnomaly, recordInputTrail, recordSyncDebug, registerDebugProbe, setSyncDebugEnabled, updateSyncDebugRequest } from "@/lib/sync-debug";

// The menu copies two reports: summary stats only, or the summary followed by every record.

afterEach(() => setSyncDebugEnabled(false));

function record() {
  setSyncDebugEnabled(true);
  const r = beginSyncDebugRequest("local edit");
  updateSyncDebugRequest(r, { totalMs: 80, httpMs: 60, phase: "Done", status: 200, pushed: 2, pushedContent: 2, uploadBytes: 4096, downloadBytes: 200 });
  recordInputAnomaly("Main thread stalled (no frames)", { ms: 640 });
  recordInputTrail("down pen #7 on page");
  recordSyncDebug("realtime", "Realtime state", { state: "live" });
  recordDebugError("console.error", "Hydration failed");
  countDebug("Input · pointerdown pen", 3);
  observeDebug("Frames per second", 58);
  observeDebug("Frames per second", 30);
  recordDebugSample({ "Frames per second": 30, "Canvas memory MB": 120, realtime: "live" });
  return registerDebugProbe("Editor", () => ({ zoom: 1.5, tool: "pen" }));
}

describe("debug reports", () => {
  it("sum stats carries summaries and no individual records", () => {
    const unregister = record();
    const report = buildDebugReport(["Device: test"], { trace: false });
    unregister();
    expect(report).toContain("Device: test");
    expect(report).toContain("Requests kept: 1 · ↑ 2 entities, 4.0 KB");
    expect(report).toContain("Triggers: local edit 1");
    expect(report).toContain("Main thread stalled (no frames): 1 · longest 640 ms");
    expect(report).toMatch(/Frames per second\s+avg\s+44 · max\s+58 · min\s+30/);
    expect(report).toContain("Input: pointerdown pen 3");
    expect(report).toContain("Errors: console.error 1");
    expect(report).toContain("Editor: zoom 1.5 · tool pen");
    expect(report).toContain("Device and page:");
    for (const record of ["down pen #7 on page", "Hydration failed", "Events:", "Requests (edits", "Resource timeline"]) expect(report).not.toContain(record);
  });

  it("stats and trace adds the timeline, anomalies, input, requests, errors and events", () => {
    const unregister = record();
    const report = buildDebugReport([], { trace: true });
    unregister();
    expect(report).toContain("Requests kept: 1");
    expect(report).toMatch(/Resource timeline[\s\S]*Frames per second \| Canvas memory MB \| realtime[\s\S]*30 \| 120 \| live/);
    expect(report).toContain("down pen #7 on page");
    expect(report).toContain("console.error · Hydration failed");
    expect(report).toContain("4.0 KB up 200 B down");
    expect(report).toContain("realtime · Realtime state · state=live");
  });

  it("a probe that throws is reported, not fatal", () => {
    setSyncDebugEnabled(true);
    const unregister = registerDebugProbe("Broken", () => { throw new TypeError("x"); });
    expect(buildDebugReport([], { trace: false })).toContain("Broken: error TypeError");
    unregister();
  });
});

describe("measureDom", () => {
  it("adds up canvas backing stores and decoded images as graphics memory stand-ins", () => {
    const doc = {
      getElementsByTagName: (tag: string) => (tag === "canvas" ? [{ width: 2048, height: 1024 }, { width: 0, height: 0 }] : { length: 42 }),
      images: [{ complete: true, naturalWidth: 1024, naturalHeight: 1024 }, { complete: false, naturalWidth: 9, naturalHeight: 9 }],
    } as unknown as Document;
    expect(measureDom(doc)).toEqual({
      "Canvas memory MB": 8, "Canvases with a bitmap": 1, "Largest canvas MP": 2.1,
      "Decoded image MB": 4, "Images loaded": 1, "DOM elements": 42,
    });
  });
});
