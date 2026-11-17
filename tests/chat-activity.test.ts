import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { emitRemoteActivity } from "@/lib/sync";
import { onActivity, type ActivityEvent } from "@/lib/activity";
import type { Entity } from "@/lib/types";

it("first sync ignores historical edits and accepts only the last two minutes", () => {
  const events: ActivityEvent[] = [];
  const stop = onActivity((e) => events.push(e));
  const at = 1794900000000;
  const entity = (wall: number) =>
    ({
      id: "x",
      kind: "stroke",
      notebookId: "n",
      hlc: `${wall}-0-other`,
      deleted: 0,
      parentId: "",
      data: {},
    }) as Entity;
  emitRemoteActivity([entity(at - 120001)], "me", at);
  expect(events).toHaveLength(0);
  emitRemoteActivity([entity(at - 120000)], "me", at);
  expect(events).toHaveLength(1);
  stop();
});
