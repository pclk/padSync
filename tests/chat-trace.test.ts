import { describe, expect, it } from "vitest";
import { alignedMarks, formatMs, noteServerTime, clientClock, timeline } from "@/lib/chat-trace";

describe("latency trace", () => {
  // Device clock 500 ms behind the server, bridge 200 ms ahead.
  const trace = {
    "client.pressed": 1_000,
    "client.sent": 1_040,
    "client.clock_offset": 500,
    "server.received": 1_620,
    "server.created": 1_650,
    "server.claimed": 3_000,
    "bridge.claimed": 3_230,
    "bridge.clock_offset": -200,
    "bridge.agent_spawn": 3_260,
    "bridge.agent_first_event": 3_760,
    "bridge.first_text": 5_260,
    "bridge.agent_exit": 9_260,
    "bridge.final_sent": 9_270,
    "server.finished": 9_150,
    "bridge.updates": 6,
  };
  const mine = { "client.response": 1_200, "client.first_output_seen": 5_600, "client.done_seen": 9_400 };

  it("puts every stamp on the server's clock", () => {
    const at = alignedMarks(trace, mine);
    expect(at["client.pressed"]).toBe(1_500);
    expect(at["bridge.claimed"]).toBe(3_030);
    expect(at["bridge.updates"]).toBeUndefined();
  });

  it("measures each stage between machines", () => {
    const { stages, firstWords, total } = timeline(trace, mine);
    const ms = Object.fromEntries(stages.map((s) => [s.label, s.ms]));
    expect(ms["Prepare on this device (context, attachments)"]).toBe(40);
    expect(ms["Request to padSync"]).toBe(80);
    expect(ms["Wait for the bridge's next poll"]).toBe(1_350);
    expect(ms["Job reaches the Mac"]).toBe(30);
    expect(ms["Agent starts up"]).toBe(500);
    expect(ms["Agent thinks (to its first words)"]).toBe(1_500);
    expect(ms["Final update to padSync"]).toBe(80);
    expect(ms["Device sees the reply (includes its poll)"]).toBe(750);
    expect(ms["Transcribe the voice message"]).toBeUndefined();
    expect(firstWords).toBe(4_600);
    expect(total).toBe(8_400);
  });

  it("keeps the round trip with the least delay as the clock estimate", () => {
    noteServerTime(10_500, 10_000, 10_400);
    noteServerTime(20_000, 19_000, 19_100);
    noteServerTime(21_000, 19_500, 20_500);
    expect(clientClock()).toMatchObject({ offset: 950, rtt: 100 });
  });

  it("formats durations", () => {
    expect(formatMs(87.4)).toBe("87 ms");
    expect(formatMs(1234)).toBe("1.23 s");
    expect(formatMs(45_600)).toBe("45.6 s");
  });
});

describe("latency report", () => {
  it("summarises every turn's stages for pasting", async () => {
    const { latencyReport } = await import("@/lib/chat-trace");
    const base = {
      context: null, agent: "codex" as const, options: { model: "gpt-6.2-sol", effort: "medium", webSearch: true },
      outputOffset: 0, error: null, createdAt: "", updatedAt: "", finishedAt: null, resultFiles: [],
    };
    const turns = [
      { ...base, jobId: "j1", turn: 1, question: "check my work", output: "Looks right", status: "done" as const,
        attachments: [{ path: "voice-message.webm", mime: "audio/webm", size: 40_000 }],
        trace: { "server.created": 1_000, "server.claimed": 2_500, "bridge.claimed": 2_520, "bridge.agent_spawn": 2_600, "bridge.first_text": 6_000, "bridge.agent_exit": 9_000, "bridge.final_sent": 9_010, "server.finished": 9_100, "client.recording_ms": 4_200 } },
      { ...base, jobId: "j2", turn: 2, question: "old", output: "x", status: "done" as const, attachments: [] },
    ];
    const md = latencyReport({ id: "t1", title: "Maths" }, turns, { device: "test", pollMs: { active: 1500, idle: 15000 }, bridgePollMs: 3000, now: new Date(0) });
    expect(md).toContain('Chat: "Maths" (t1), 2 turns, 1 with timings');
    expect(md).toContain("| Wait for the bridge's next poll | 1 | 1.50 s | 1.50 s |");
    expect(md).toContain("codex · gpt-6.2-sol · effort medium · web search");
    expect(md).toContain("voice message, 30 KB, 4.20 s recorded");
    expect(md).toContain("## Turn 2: done");
    expect(md).toContain("No timings");
    expect(md).toContain('"jobId": "j1"');
  });
});
