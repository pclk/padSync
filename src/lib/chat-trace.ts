// Latency trace of a chat turn, from the key press to the reply on screen. Each machine stamps
// what it saw with its own clock (epoch ms): the device ("client."), padSync's server and database
// ("server."), and the Mac bridge ("bridge."). Device and bridge clocks are shifted onto the
// server's with offsets measured from round trips, so stages that cross machines line up.
//
// The device's stamps from before the turn exists travel with the turn; the ones after (response,
// first words seen, reply seen) are kept in this browser and sent to the turn's trace as they happen,
// so a report has them on any device.

import type { ThreadSummary, Turn } from "./chat-types";

export type Trace = Record<string, number>;

/** Server time minus device time, from the round trip with the smallest delay. */
let clock: { offset: number; rtt: number; at: number } | null = null;

/** Called around a request whose response carries the server's time. */
export function noteServerTime(serverNow: string | number, sentAt: number, receivedAt: number) {
  const server = typeof serverNow === "number" ? serverNow : Date.parse(serverNow);
  const rtt = receivedAt - sentAt;
  if (!Number.isFinite(server) || rtt < 0) return;
  // A sample from the last minute with a shorter round trip is the better estimate.
  if (clock && clock.rtt <= rtt && receivedAt - clock.at < 60_000) return;
  clock = { offset: server - (sentAt + receivedAt) / 2, rtt, at: receivedAt };
}

export const clientClock = () => clock;

const KEY = "padsync.chat.trace.";
const local = new Map<string, Trace>();

/** This browser's own stamps for a turn (see the header). */
export function localMarks(jobId: string): Trace {
  let marks = local.get(jobId);
  // Read again while empty: the tab that sent the turn may have stamped it since this one looked.
  if (!marks || !Object.keys(marks).length) {
    try {
      marks = JSON.parse(localStorage.getItem(KEY + jobId) ?? "{}") as Trace;
    } catch {
      marks = {};
    }
    local.set(jobId, marks);
  }
  return marks;
}

/** Stamps `key` once (the first time is the one that counts); true when this call did. */
export function markLocal(jobId: string, key: string, at = Date.now()): boolean {
  const marks = localMarks(jobId);
  if (marks[key] !== undefined) return false;
  marks[key] = at;
  try {
    localStorage.setItem(KEY + jobId, JSON.stringify(marks));
  } catch {
    // Storage full or blocked: the trace still works until reload.
  }
  return true;
}

export interface Stage {
  label: string;
  /** Milliseconds from the start of the turn, on the server's clock. */
  start: number;
  ms: number;
  /** Crosses the network (includes polling delays where noted in the label). */
  network: boolean;
}

/** label, from, to (first present mark of each list wins), crosses the network. */
const STAGES: [string, string[], string[], boolean][] = [
  ["Prepare on this device (context, attachments)", ["client.pressed"], ["client.sent"], false],
  ["Request to padSync", ["client.sent"], ["server.received"], true],
  ["Server saves the turn", ["server.received"], ["server.created"], false],
  ["Response back to the device", ["server.created"], ["client.response"], true],
  ["Upload attachments", ["client.response"], ["server.queued"], true],
  ["Wait for the bridge's next poll", ["server.queued", "server.created"], ["server.claimed"], true],
  ["Job reaches the Mac", ["server.claimed"], ["bridge.claimed"], true],
  ["Fetch attachments", ["bridge.claimed"], ["bridge.inputs_fetched"], true],
  ["Transcribe the voice message", ["bridge.transcribe_start"], ["bridge.transcribed"], false],
  ["Send the transcript", ["bridge.transcribed"], ["bridge.transcript_sent"], true],
  ["Prepare the job folder", ["bridge.transcript_sent", "bridge.inputs_fetched", "bridge.claimed"], ["bridge.agent_spawn"], false],
  ["Agent starts up", ["bridge.agent_spawn"], ["bridge.agent_first_event"], false],
  ["Agent thinks (to its first words)", ["bridge.agent_first_event", "bridge.agent_spawn"], ["bridge.first_text"], false],
  ["Agent writes the reply", ["bridge.first_text"], ["bridge.agent_exit"], false],
  ["Collect returned files", ["bridge.agent_exit"], ["bridge.final_sent"], false],
  ["Final update to padSync", ["bridge.final_sent"], ["server.finished"], true],
  ["Device sees the reply (includes its poll)", ["server.finished"], ["client.done_seen"], true],
];

const isOffset = (k: string) => k.endsWith("clock_offset") || k.endsWith("_rtt") || k.endsWith("_ms") || k.endsWith("updates");

/** Every stamp on the server's clock. */
export function alignedMarks(trace: Trace, mine: Trace, fallbackClientOffset = 0): Trace {
  const clientOffset = trace["client.clock_offset"] ?? fallbackClientOffset;
  const bridgeOffset = trace["bridge.clock_offset"] ?? 0;
  const out: Trace = {};
  for (const [k, v] of Object.entries({ ...trace, ...mine })) {
    if (isOffset(k) || typeof v !== "number") continue;
    out[k] = k.startsWith("client.") ? v + clientOffset : k.startsWith("bridge.") ? v + bridgeOffset : v;
  }
  return out;
}

export function timeline(trace: Trace, mine: Trace, fallbackClientOffset = 0) {
  const at = alignedMarks(trace, mine, fallbackClientOffset);
  const first = (keys: string[]) => keys.map((k) => at[k]).find((v) => v !== undefined);
  const t0 = at["client.pressed"] ?? at["server.received"] ?? at["server.created"] ?? Math.min(...Object.values(at));
  const stages: Stage[] = [];
  for (const [label, from, to, network] of STAGES) {
    const a = first(from);
    const b = first(to);
    if (a === undefined || b === undefined) continue;
    stages.push({ label, start: a - t0, ms: b - a, network });
  }
  const since = (k: string) => (at[k] === undefined ? undefined : at[k] - t0);
  return {
    stages,
    firstWords: since("client.first_output_seen"),
    total: since("client.done_seen") ?? since("server.finished"),
  };
}

export function formatMs(ms: number) {
  if (Math.abs(ms) < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const VOICE = /^voice-message\./;

/**
 * Every turn's trace as Markdown, to paste into a conversation about speeding replies up: the
 * setup, a per-stage summary across turns, each turn's stages, then the raw stamps.
 */
export function latencyReport(
  thread: Pick<ThreadSummary, "id" | "title">,
  turns: Turn[],
  env: { device: string; pollMs: { active: number; idle: number }; bridgePollMs: number; realtime?: boolean; now?: Date },
) {
  const offset = clientClock()?.offset ?? 0;
  const rows = turns.map((t) => ({ t, mine: localMarks(t.jobId), ...timeline(t.trace ?? {}, localMarks(t.jobId), offset) }));
  const traced = rows.filter((r) => r.stages.length);
  const lines: string[] = [
    `# padSync chat latency report`,
    ``,
    `- Chat: "${thread.title || "Untitled"}" (${thread.id}), ${turns.length} turns, ${traced.length} with timings`,
    `- Generated: ${(env.now ?? new Date()).toISOString()} on ${env.device}`,
    `- Device polls the thread every ${env.pollMs.active} ms while a reply is running (${env.pollMs.idle} ms otherwise); the bridge polls for jobs every ${env.bridgePollMs} ms when idle${env.realtime ? "; realtime push is connected, so changes reach the device as they happen and polling is a backup" : ""}`,
    `- Times are on the server's clock; device and bridge clocks are aligned from round trips (± half the round trip shown per turn)`,
  ];
  if (traced.length) {
    const byStage = new Map<string, number[]>();
    for (const r of traced) for (const s of r.stages) byStage.set(s.label, [...(byStage.get(s.label) ?? []), s.ms]);
    const totals = traced.map((r) => r.total).filter((v): v is number => v !== undefined);
    const firsts = traced.map((r) => r.firstWords).filter((v): v is number => v !== undefined);
    const allTime = totals.reduce((a, b) => a + b, 0);
    lines.push(``, `## Summary across turns`, ``);
    if (firsts.length) lines.push(`- First words on screen: median ${formatMs(median(firsts))}, max ${formatMs(Math.max(...firsts))}`);
    if (totals.length) lines.push(`- Reply complete: median ${formatMs(median(totals))}, max ${formatMs(Math.max(...totals))}`);
    lines.push(``, `| Stage | Turns | Median | Max | Share of all time |`, `|---|---|---|---|---|`);
    for (const [label, xs] of byStage) {
      const sum = xs.reduce((a, b) => a + b, 0);
      lines.push(`| ${label} | ${xs.length} | ${formatMs(median(xs))} | ${formatMs(Math.max(...xs))} | ${allTime ? `${Math.round((sum / allTime) * 100)}%` : "–"} |`);
    }
  }
  for (const r of rows) {
    const { t } = r;
    const tr = t.trace ?? {};
    const tools = [t.options.webSearch && "web search", t.options.allowEdits && "edits", t.options.allowCode && "code"].filter(Boolean).join(", ");
    const voice = t.attachments.find((a) => VOICE.test(a.path));
    const files = t.attachments.filter((a) => !VOICE.test(a.path));
    lines.push(
      ``,
      `## Turn ${t.turn}: ${t.status}`,
      ``,
      `- ${t.agent}${t.options.model ? ` · ${t.options.model}` : " · default model"}${t.options.effort ? ` · effort ${t.options.effort}` : ""}${tools ? ` · ${tools}` : ""}${t.options.account ? ` · account ${t.options.account}` : ""}`,
      `- Question ${t.question.length} chars${voice ? ` (voice message, ${Math.round(voice.size * 0.75 / 1000)} KB${tr["client.recording_ms"] ? `, ${formatMs(tr["client.recording_ms"])} recorded` : ""})` : ""}; reply ${t.output.length} chars; ${files.length} attachments${files.length ? ` (${Math.round(files.reduce((n, a) => n + a.size * 0.75, 0) / 1000)} KB)` : ""}; context ${t.context ? `${t.context.scope}, ~${t.context.tokens.toLocaleString()} tokens` : "none"}${t.resultFiles.length ? `; returned ${t.resultFiles.length} files` : ""}`,
    );
    if (t.error) lines.push(`- Error: ${t.error.slice(0, 300)}`);
    if (!r.stages.length) {
      lines.push(`- No timings (sent before tracing, or by an older server/bridge)`);
      continue;
    }
    const clocks = [
      tr["client.clock_rtt"] !== undefined && `device ±${formatMs(tr["client.clock_rtt"] / 2)}`,
      tr["bridge.claim_rtt"] !== undefined && `bridge ±${formatMs(tr["bridge.claim_rtt"] / 2)}`,
      tr["bridge.updates"] && `${tr["bridge.updates"]} bridge updates, ${formatMs(tr["bridge.update_ms"] / tr["bridge.updates"])} each`,
    ].filter(Boolean);
    lines.push(
      `- First words ${r.firstWords === undefined ? "–" : formatMs(r.firstWords)}; complete ${r.total === undefined ? "–" : formatMs(r.total)}${clocks.length ? `; ${clocks.join(", ")}` : ""}`,
      ``,
      `| Stage | Starts at | Took | |`,
      `|---|---|---|---|`,
      ...r.stages.map((s) => `| ${s.label} | +${formatMs(s.start)} | ${formatMs(s.ms)} | ${s.network ? "network" : "work"} |`),
    );
  }
  lines.push(
    ``,
    `## Raw stamps (epoch ms; "device" = this browser's own)`,
    ``,
    "```json",
    JSON.stringify(rows.map((r) => ({ turn: r.t.turn, jobId: r.t.jobId, status: r.t.status, trace: r.t.trace ?? {}, device: r.mine })), null, 1),
    "```",
  );
  return lines.join("\n");
}
