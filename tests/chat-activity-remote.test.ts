import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { emitRemoteActivity } from "@/lib/sync";
import { onActivity, type ActivityEvent } from "@/lib/activity";
import type { Entity } from "@/lib/types";
it("Remote edits ignore own device and presence, group once per notebook including deletes", () => {
  const events: ActivityEvent[] = [];
  const stop = onActivity((e) => events.push(e));
  const e = (kind: Entity["kind"], notebookId = "a", device = "other") =>
    ({
      id: "id",
      kind,
      notebookId,
      hlc: `1-0-${device}`,
      deleted: 1,
      parentId: "",
      data: {},
      dirty: 0,
    }) as Entity;
  emitRemoteActivity(
    [
      e("stroke"),
      e("textbox"),
      e("section"),
      e("presence"),
      e("stroke", "own", "me"),
      e("stroke", "b"),
    ],
    "me",
    42,
  );
  stop();
  expect(events).toHaveLength(2);
  expect(events[0]).toEqual({
    notebookId: "a",
    source: "remote",
    kinds: ["stroke", "text", "section"],
    at: 42,
  });
  expect(events[1].notebookId).toBe("b");
});
