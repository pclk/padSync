import type {
  NewThread,
  NewTurn,
  ThreadPatch,
  ThreadSummary,
  ThreadResponse,
  ThreadListResponse,
  Turn,
} from "./chat-types";
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("You're offline; chat needs a connection.");
  }
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? "Sign in on the Settings page first."
        : res.status === 503
          ? "Server database is not set up."
          : (data.error ?? `HTTP ${res.status}`),
    );
  return data;
}
const path = (id: string) => `/api/chat/threads/${encodeURIComponent(id)}`;
export const listThreads = (
  filter: { notebookId?: string; q?: string; archived?: boolean } = {},
) =>
  call<ThreadListResponse>(
    "/api/chat/threads?" +
      new URLSearchParams(
        Object.entries(filter)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [
            k,
            typeof v === "boolean" ? (v ? "1" : "0") : String(v),
          ]),
      ),
  );
export const createThread = (input: NewThread) =>
  call<{ thread: ThreadSummary }>("/api/chat/threads", "POST", input);
export const updateThread = (id: string, input: ThreadPatch) =>
  call<{ thread: ThreadSummary }>(path(id), "PATCH", input);
export const deleteThread = (id: string) =>
  call<{ ok: true }>(path(id), "DELETE");
export const getThread = (
  id: string,
  query: { since?: string; from?: string } = {},
) =>
  call<ThreadResponse>(
    path(id) +
      "?" +
      new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
  );
export const sendTurn = (id: string, input: NewTurn) =>
  call<{ turn: Turn }>(path(id) + "/turns", "POST", input);
export const regenerateTurn = (id: string, turn: number) =>
  call<{ turn: Turn }>(path(id) + `/turns/${turn}/regenerate`, "POST");
export const forkThread = (id: string, uptoTurn: number, title?: string) =>
  call<{ thread: ThreadSummary }>(path(id) + "/fork", "POST", {
    uptoTurn,
    title,
  });
export const cancelTurn = (jobId: string) =>
  call<unknown>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, "POST");
export function mergeTurns(prev: Turn[], incoming: Turn[]): Turn[] {
  const map = new Map(prev.map((t) => [t.turn, t]));
  for (const t of incoming) {
    const old = map.get(t.turn);
    if (old && old.updatedAt >= t.updatedAt) continue;
    if (t.outputOffset && (!old || t.outputOffset > old.output.length))
      continue;
    map.set(t.turn, {
      ...t,
      output:
        (t.outputOffset ? old!.output.slice(0, t.outputOffset) : "") + t.output,
      outputOffset: 0,
    });
  }
  return [...map.values()].sort((a, b) => a.turn - b.turn);
}
