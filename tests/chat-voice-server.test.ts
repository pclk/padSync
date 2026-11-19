import { beforeEach, expect, it } from "vitest";
import { freshDb } from "./helpers/env";
import type { Sql } from "@/server/db";
import * as c from "@/server/chat";
import { claimJob, updateJob } from "@/server/jobs";

let sql: Sql;
beforeEach(async () => {
  ({ sql } = await freshDb());
});
const thread = async () => (await c.createThread(sql, { notebookId: "nb", title: "", agent: "claude", options: {} }))!;
const voice = { path: "voice-message.webm", mime: "audio/webm", base64: "GkXfow==" };

it("a voice turn waits for a bridge that transcribes, which fills the question and title", async () => {
  const t = await thread();
  const sent = (await c.createTurn(sql, t.id, { question: "", files: [voice], uploads: [] }))!;
  expect(sent.question).toBe("");
  expect(await claimJob(sql, "old", ["claude"], ["chat"])).toBeNull();
  const job = (await claimJob(sql, "b", ["claude"], ["chat", "voice"]))!;
  expect(job.files.map((f) => f.path)).toEqual(["voice-message.webm"]);
  await updateJob(sql, job.id, "b", { question: "Explain the Krebs cycle" });
  // A second transcript (a reclaimed job) does not overwrite the first.
  await updateJob(sql, job.id, "b", { question: "something else" });
  const [turn] = await c.getTurns(sql, t.id);
  expect(turn.question).toBe("Explain the Krebs cycle");
  expect((await c.getThread(sql, t.id))?.title).toBe("Explain the Krebs cycle");
});

it("plain turns ignore a question update; empty turns without a recording are refused", async () => {
  const t = await thread();
  await c.createTurn(sql, t.id, { question: "typed", files: [], uploads: [] });
  const job = (await claimJob(sql, "b", ["claude"], ["chat", "voice"]))!;
  await updateJob(sql, job.id, "b", { question: "nope" });
  expect((await c.getTurns(sql, t.id))[0].question).toBe("typed");
  await expect(c.createTurn(sql, t.id, { question: "", files: [], uploads: [] })).rejects.toThrow("Invalid attachments");
  await expect(
    c.createTurn(sql, t.id, { question: "", files: [voice, { ...voice, path: "voice-message.ogg", mime: "audio/ogg" }], uploads: [] }),
  ).rejects.toThrow("Invalid attachments");
});

it("regenerate drops a transcribed recording but resends one that was never transcribed", async () => {
  const t = await thread();
  await c.createTurn(sql, t.id, { question: "", files: [voice], uploads: [] });
  let job = (await claimJob(sql, "b", ["claude"], ["chat", "voice"]))!;
  await updateJob(sql, job.id, "b", { status: "error", error: "speech worker exited" });
  const retry = (await c.regenerate(sql, t.id, 1))!;
  expect(retry.attachments.map((a) => a.path)).toEqual(["voice-message.webm"]);
  job = (await claimJob(sql, "b", ["claude"], ["chat", "voice"]))!;
  await updateJob(sql, job.id, "b", { question: "heard it" });
  await updateJob(sql, job.id, "b", { status: "done", output: "answer" });
  const again = (await c.regenerate(sql, t.id, 2))!;
  expect(again.question).toBe("heard it");
  expect(again.attachments).toEqual([]);
});

it("stamps the server's side of the latency trace and keeps the device's and bridge's", async () => {
  const t = await thread();
  await c.createTurn(sql, t.id, { question: "hi", files: [], uploads: [], trace: { "client.pressed": 1, "client.sent": 2 } });
  const job = (await claimJob(sql, "b", ["claude"], ["chat"]))!;
  await updateJob(sql, job.id, "b", { output: "", trace: { "bridge.claimed": 5 } });
  await updateJob(sql, job.id, "b", { output: "Hel", trace: { "bridge.first_text": 6 } });
  await updateJob(sql, job.id, "b", { output: "Hello", status: "done", trace: { "bridge.final_sent": 7 } });
  const trace = (await c.getTurns(sql, t.id))[0].trace!;
  expect(trace).toMatchObject({ "client.pressed": 1, "client.sent": 2, "bridge.claimed": 5, "bridge.first_text": 6, "bridge.final_sent": 7 });
  for (const k of ["server.received", "server.created", "server.claimed", "server.first_output", "server.finished"]) expect(typeof trace[k]).toBe("number");
  expect(trace["server.created"]).toBeLessThanOrEqual(trace["server.claimed"]);
  expect(trace["server.first_output"]).toBeLessThanOrEqual(trace["server.finished"]);
  expect(Math.abs(trace["server.received"] - Date.now())).toBeLessThan(60_000);
});
