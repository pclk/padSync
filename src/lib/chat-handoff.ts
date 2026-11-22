import { db, deviceId } from "./db";
import { putEntities } from "./store";
import type { Entity } from "./types";

// The iPad app has no chat panel: its prompts go to the chat the Mac has open on the notebook,
// and the reply is read there. Two synced rows (kind "presence", deviceKind "chat", so nothing
// that looks for the iPad's place reads them) carry the hand-off:
// - `chatfocus-<device>`: the chat a computer's panel shows on a notebook, for the app to send to.
// - `chatping-<device>`: the chat the app just sent a prompt to, for the computer to show at once.

export const FOCUS_PREFIX = "chatfocus-";
export const PING_PREFIX = "chatping-";

export interface ChatHandoffData {
  device: string;
  deviceKind: "chat";
  chatThreadId: string;
  at: number;
}

export type ChatHandoffEntity = Entity<"presence", ChatHandoffData>;

/** Records the chat this computer's panel shows on `notebookId`. */
export async function publishChatFocus(notebookId: string, chatThreadId: string) {
  const id = FOCUS_PREFIX + deviceId();
  const prev = await db.entities.get(id);
  const data: ChatHandoffData = { device: deviceId(), deviceKind: "chat", chatThreadId, at: Date.now() };
  await putEntities([{ id, kind: "presence", notebookId, parentId: "", data, hlc: prev?.hlc ?? "", deleted: 0, dirty: 1 }]);
}

/** The newest ping from another device on `notebookId`, if any. */
export async function latestChatPing(notebookId: string): Promise<ChatHandoffEntity | undefined> {
  const rows = (await db.entities.where("kind").equals("presence").toArray()) as unknown as ChatHandoffEntity[];
  return rows
    .filter((r) => r.id.startsWith(PING_PREFIX) && r.notebookId === notebookId && !r.deleted && r.data.device !== deviceId() && typeof r.data.chatThreadId === "string")
    .sort((a, b) => b.data.at - a.data.at)[0];
}
