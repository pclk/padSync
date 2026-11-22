import { describe, expect, it, vi } from "vitest";
import { NATIVE_CHANGE_EVENT, nativeStore } from "../src/lib/native-store";
import type { Entity } from "../src/lib/types";

function fakeApp(reply: (message: Record<string, unknown>) => unknown, store = true) {
  const sent: Record<string, unknown>[] = [];
  const target = new EventTarget();
  const win = {
    padsyncNative: { version: 2, store },
    webkit: { messageHandlers: { padsyncStore: { postMessage: async (m: Record<string, unknown>) => { sent.push(m); return reply(m); } } } },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  return { win, sent };
}

const stroke: Entity = { id: "k1", kind: "stroke", notebookId: "nb", parentId: "s1", data: {}, hlc: "1-0000-app", deleted: 0, dirty: 0 };

describe("nativeStore", () => {
  it("is null outside the app and in app builds without the store bridge", () => {
    expect(nativeStore(undefined)).toBeNull();
    expect(nativeStore({})).toBeNull();
    expect(nativeStore(fakeApp(() => null, false).win)).toBeNull();
  });

  it("sends the ops StoreBridge.swift answers", async () => {
    const { win, sent } = fakeApp((m) => (m.op === "get" ? (m.id === "k1" ? stroke : null) : [stroke]));
    const store = nativeStore(win)!;
    expect(await store.get("k1")).toEqual(stroke);
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.list("nb", { kind: "stroke", parentId: "s1" })).toEqual([stroke]);
    await store.notebooks();
    expect(await store.put([stroke])).toEqual([stroke]);
    expect(await store.put([])).toEqual([]);
    expect(sent).toEqual([
      { op: "get", id: "k1" },
      { op: "get", id: "missing" },
      { op: "list", notebookId: "nb", kind: "stroke", parentId: "s1" },
      { op: "notebooks" },
      { op: "put", entities: [stroke] },
    ]);
  });

  it("passes the app's errors through", async () => {
    const { win } = fakeApp(() => { throw new Error("unknown op"); });
    await expect(nativeStore(win)!.notebooks()).rejects.toThrow("unknown op");
  });

  it("calls back on change events until unsubscribed", () => {
    const { win } = fakeApp(() => null);
    const callback = vi.fn();
    const off = nativeStore(win)!.onChange(callback);
    win.dispatchEvent(new Event(NATIVE_CHANGE_EVENT));
    off();
    win.dispatchEvent(new Event(NATIVE_CHANGE_EVENT));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
