import { expect, it } from "vitest";
import { mergeTurns, pollCursor, uploadSpecs } from "@/lib/chat-api";
import type { Turn } from "@/lib/chat-types";
it("emoji and math italic survive several streaming polls", () => {
  let turns: Turn[] = [];
  for (const [i, output] of ["Hi 😀", "Hi 😀 𝑥", "Hi 😀 𝑥 done"].entries()) {
    const offset = i ? Array.from(turns[0].output).length : 0;
    turns = mergeTurns(turns, [
      {
        turn: 1,
        output: Array.from(output).slice(offset).join(""),
        outputOffset: offset,
        updatedAt: String(i),
        status: "running",
      } as Turn,
    ]);
    expect(turns[0].output).toBe(output);
    expect(pollCursor(turns)).toBe(`1:${Array.from(output).length}:0`);
  }
});
it("upload specs reject unsupported types", () => {
  expect(() =>
    uploadSpecs([
      { path: "x.exe", mime: "application/octet-stream", base64: "QQ==" },
    ]),
  ).toThrow(/image|PDF/);
});

it("splits uploads and queues a chat job through the inputs route on pglite", async () => {
  const { freshDb, configureAuthEnv, sessionCookie, req, params } =
    await import("./helpers/env");
  const { sql } = await freshDb();
  configureAuthEnv();
  const c = await import("@/server/chat");
  const { PUT } = await import("@/app/api/jobs/[id]/inputs/route");
  const { uploadTurnInputs } = await import("@/lib/chat-api");
  const { PART_CHARS } = await import("@/lib/uploads");
  const { vi } = await import("vitest");
  const files = [
    {
      path: "scan.pdf",
      mime: "application/pdf",
      base64: "A".repeat(PART_CHARS) + "QQ==",
    },
  ];
  const t = (await c.createThread(sql, {
    agent: "claude",
    title: "",
    notebookId: "",
    options: {},
  }))!;
  const job = (await c.createTurn(sql, t.id, {
    question: "read",
    files: [],
    uploads: uploadSpecs(files),
  }))!;
  expect(job.status).toBe("uploading");
  const lengths: number[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    lengths.push(body.data.length);
    return PUT(
      req(`/api/jobs/${job.jobId}/inputs`, {
        method: "PUT",
        body,
        session: sessionCookie(),
      }),
      params({ id: job.jobId }),
    );
  });
  try {
    await uploadTurnInputs(job.jobId, files);
  } finally {
    vi.unstubAllGlobals();
  }
  expect(lengths).toEqual([PART_CHARS, 4]);
  expect((await c.getTurns(sql, t.id))[0].status).toBe("queued");
});
