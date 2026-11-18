import { environment, getResourceSnapshot } from "./perf-watch";
import { clock, formatSyncSummary, formatSyncTrace, getDebugSummaries, readDebugProbes, type DebugStat, type DebugValue } from "./sync-debug";

// The two reports the sync debug menu copies. "Sum stats" is every summary (averages, counters,
// resources, probes) and no individual records; "stats and trace" adds the records after it.

const n = (v: number) => (Math.abs(v) >= 100 ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`);
const value = (v: DebugValue) => (typeof v === "number" ? n(v) : String(v));

function statLines(stats: Map<string, DebugStat>, filter: (name: string) => boolean) {
  const rows = [...stats].filter(([name]) => filter(name)).sort(([a], [b]) => a.localeCompare(b));
  return rows.map(([name, s]) => `  ${name.padEnd(48)} avg ${n(s.sum / s.n).padStart(7)} · max ${n(s.max).padStart(7)} · min ${n(s.min).padStart(7)} · now ${n(s.last).padStart(7)} · n ${s.n}`);
}

export function formatPerfSummary(now = Date.now()) {
  const { since, counters, stats } = getDebugSummaries();
  const lines = ["", `Device and page:`, ...environment().map((l) => `  ${l}`)];
  lines.push("", `Recording: ${n((now - since) / 60000)} min since ${clock(since)}`);

  const resources = getResourceSnapshot();
  lines.push("", "Resources now:");
  lines.push(...Object.entries(resources).map(([k, v]) => `  ${k}: ${value(v)}`));
  const resourceNames = new Set(Object.keys(resources));
  lines.push("", "Resources over the recording:", ...statLines(stats, (name) => resourceNames.has(name)));

  lines.push("", "Runtime:", ...statLines(stats, (name) => !resourceNames.has(name) && !name.startsWith("Input delay") && !name.startsWith("Interaction")));
  lines.push("", "Input latency:", ...statLines(stats, (name) => name.startsWith("Input delay") || name.startsWith("Interaction")));

  const groups = new Map<string, [string, number][]>();
  for (const [name, count] of counters) {
    const [group, label] = name.includes(" · ") ? name.split(" · ", 2) : ["Other", name];
    groups.set(group, [...(groups.get(group) ?? []), [label, count]]);
  }
  lines.push("", "Counters:");
  for (const [group, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${group}: ${rows.sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} ${c}`).join(" · ")}`);
  }

  lines.push("", "Live state:");
  for (const [probe, values] of Object.entries(readDebugProbes())) {
    lines.push(`  ${probe}: ${Object.entries(values).map(([k, v]) => `${k} ${value(v)}`).join(" · ")}`);
  }
  return lines;
}

export function formatTimeline() {
  const { timeline } = getDebugSummaries();
  const lines = ["", `Resource timeline (every 5 s, last ${timeline.length}):`];
  if (!timeline.length) return [...lines, "none recorded"];
  const keys = ["Frames per second", "Canvas memory MB", "Decoded image MB", "DOM elements", "JS heap used MB", "realtime", "sync", "visible"].filter((k) => timeline.some((t) => k in t.values));
  lines.push(`  time         ${keys.join(" | ")}`);
  for (const t of timeline) lines.push(`  ${clock(t.at)} ${keys.map((k) => (k in t.values ? value(t.values[k]) : "—")).join(" | ")}`);
  return lines;
}

export function buildDebugReport(header: string[], { trace }: { trace: boolean }, now = Date.now()) {
  const lines = [...formatSyncSummary(header, now), ...formatPerfSummary(now)];
  if (trace) lines.push(...formatTimeline(), ...formatSyncTrace());
  return lines.join("\n");
}
