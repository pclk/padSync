import { beforeEach, expect, it } from "vitest";
import { freshDb } from "./helpers/env";
import type { Sql } from "@/server/db";
import * as c from "@/server/chat";
import { claimJob, updateJob } from "@/server/jobs";
let sql: Sql;
beforeEach(async () => {
  ({ sql } = await freshDb());
});
const thread = () =>
  c.createThread(sql, {
    notebookId: "nb",
    title: "",
    agent: "claude",
    options: {},
  });
const turn = (id: string, question = "hello") =>
  c.createTurn(sql, id, { question, files: [], uploads: [] });
it("Thread CRUD, title and turn text search, archived filter, soft delete cancels running turns", async () => {
  const t = (await thread())!;
  await turn(t.id, "first question\nrest");
  expect((await c.getThread(sql, t.id))?.title).toBe("first question");
  expect(await c.listThreads(sql, { q: "rest" })).toHaveLength(1);
  await c.patchThread(sql, t.id, { title: "renamed", archived: true });
  expect(await c.listThreads(sql)).toHaveLength(0);
  expect(
    await c.listThreads(sql, { archived: true, q: "renamed" }),
  ).toHaveLength(1);
  await claimJob(sql, "bridge", ["claude"], ["chat"]);
  await c.deleteThread(sql, t.id);
  expect(await c.getThread(sql, t.id)).toBeNull();
  expect((await c.getTurns(sql, t.id))[0].status).toBe("cancelled");
});
it("Concurrent POST allocation is unique and gap-free", async () => {
  const t = (await thread())!;
  await Promise.all(Array.from({ length: 8 }, () => turn(t.id)));
  expect((await c.getTurns(sql, t.id)).map((t) => t.turn)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});
it.each(["done", "error", "cancelled"] as const)(
  "Claim order blocks queued/running predecessors; %s releases next; old bridge excluded",
  async (status) => {
    const t = (await thread())!;
    const a = (await turn(t.id))!;
    await turn(t.id);
    expect(await claimJob(sql, "old", ["claude"])).toBeNull();
    expect((await claimJob(sql, "b", ["claude"], ["chat"]))?.id).toBe(a.jobId);
    expect(await claimJob(sql, "c", ["claude"], ["chat"])).toBeNull();
    await sql.query("update jobs set status=$1 where id=$2", [status, a.jobId]);
    expect(await claimJob(sql, "c", ["claude"], ["chat"])).not.toBeNull();
  },
);
it("since/from polls return changed turns and delta output; captures final session", async () => {
  const t = (await thread())!;
  const a = (await turn(t.id))!;
  await claimJob(sql, "b", ["claude"], ["chat"]);
  await updateJob(sql, a.jobId, "b", { output: "abcdef" });
  expect((await c.getTurns(sql, t.id, undefined, "1:3"))[0].output).toBe("def");
  expect(await c.getTurns(sql, t.id, "2099-01-01")).toEqual([]);
  await updateJob(sql, a.jobId, "b", { status: "done", sessionId: "session" });
  expect(
    (
      await sql.query<{ agent_session: unknown }>(
        "select agent_session from chat_threads where id=$1",
        [t.id],
      )
    )[0].agent_session,
  ).toEqual({ agent: "claude", sessionId: "session" });
});
it("Regenerate only last; fork copies done turns up to N without session", async () => {
  const t = (await thread())!;
  await turn(t.id);
  await turn(t.id);
  expect(await c.regenerate(sql, t.id, 1)).toBeNull();
  expect((await c.regenerate(sql, t.id, 2))?.turn).toBe(3);
  await sql.query(
    "update jobs set status='done' where thread_id=$1 and turn=1",
    [t.id],
  );
  const fork = (await c.forkThread(sql, t.id, 2))!;
  expect(await c.getTurns(sql, fork.id)).toHaveLength(1);
  expect(
    (
      await sql.query<{ agent_session: unknown }>(
        "select agent_session from chat_threads where id=$1",
        [fork.id],
      )
    )[0].agent_session,
  ).toBeNull();
});
it("Regeneration preserves inline attachment content and context after inputs are cleared", async () => {
  const t = (await thread())!;
  const a = (await c.createTurn(sql, t.id, {
    question: "read",
    files: [{ path: "note.md", mime: "text/markdown", text: "contents" }],
    uploads: [],
    context: {
      scope: "section",
      sectionIds: ["s"],
      label: "section",
      bytes: 8,
      tokens: 2,
    },
  }))!;
  await claimJob(sql, "b", ["claude"], ["chat"]);
  await updateJob(sql, a.jobId, "b", { status: "done" });
  const next = (await c.regenerate(sql, t.id, 1))!;
  expect(next.attachments[0].path).toBe("note.md");
  expect(next.context?.label).toBe("section");
  expect((await claimJob(sql, "b", ["claude"], ["chat"]))?.files[0].text).toBe(
    "contents",
  );
});

it("Regeneration reuses uploaded attachment parts after bridge completion", async () => {
  const { putJobInput } = await import("@/server/jobs");
  const t = (await thread())!;
  const a = (await c.createTurn(sql, t.id, {
    question: "read",
    files: [],
    uploads: [{ path: "scan.png", mime: "image/png", size: 4, parts: 1 }],
  }))!;
  await putJobInput(sql, a.jobId, { path: "scan.png", part: 0, data: "QQ==" });
  await claimJob(sql, "b", ["claude"], ["chat"]);
  await updateJob(sql, a.jobId, "b", { status: "done" });
  const next = (await c.regenerate(sql, t.id, 1))!;
  expect(next.status).toBe("queued");
  expect(
    (
      await sql.query<{ data: string }>(
        "select data from job_inputs where job_id=$1",
        [next.jobId],
      )
    )[0].data,
  ).toBe("QQ==");
});

it("Cancelled chat turns retain uploaded attachments for regeneration", async () => {
  const { putJobInput, cancelJob } = await import("@/server/jobs");
  const t = (await thread())!;
  const a = (await c.createTurn(sql, t.id, {
    question: "read",
    files: [],
    uploads: [{ path: "scan.png", mime: "image/png", size: 4, parts: 1 }],
  }))!;
  await putJobInput(sql, a.jobId, { path: "scan.png", part: 0, data: "QQ==" });
  await cancelJob(sql, a.jobId);
  expect((await c.regenerate(sql, t.id, 1))?.status).toBe("queued");
});
