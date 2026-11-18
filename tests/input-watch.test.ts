import { afterEach, expect, it } from "vitest";
import { formatSyncDebugReport, getSyncDebugSnapshot, recordInputAnomaly, recordSyncDebug, setSyncDebugEnabled } from "@/lib/sync-debug";

// Stalls and input oddities on the iPad get their own list in the stats report, so the sync
// event chatter (150 events) never pushes the evidence of a freeze out.

afterEach(() => setSyncDebugEnabled(false));

it("records nothing while sync debug is off", () => {
  recordInputAnomaly("Main thread stalled (no frames)", { ms: 900 });
  expect(getSyncDebugSnapshot().anomalies).toEqual([]);
});

it("keeps stalls in the report after the event log has moved on", () => {
  setSyncDebugEnabled(true);
  recordInputAnomaly("Main thread stalled (no frames)", { ms: 912.4, realtime: "connecting", inking: false });
  for (let i = 0; i < 200; i++) recordSyncDebug("schedule", "Sync scheduled");
  const report = formatSyncDebugReport([]);
  expect(report).toContain("Input and main-thread stalls (last 40):");
  expect(report).toMatch(/Main thread stalled \(no frames\) · ms=912\.4 realtime=connecting inking=false/);
  expect(getSyncDebugSnapshot().events.some((e) => e.kind === "input")).toBe(false);
});

it("says so when nothing was recorded, and keeps only the newest 40", () => {
  setSyncDebugEnabled(true);
  expect(formatSyncDebugReport([])).toContain("none recorded");
  for (let i = 0; i < 45; i++) recordInputAnomaly("Input waited for the main thread", { ms: 300 + i });
  const kept = getSyncDebugSnapshot().anomalies;
  expect(kept).toHaveLength(40);
  expect(kept[0].details.ms).toBe(305);
});
