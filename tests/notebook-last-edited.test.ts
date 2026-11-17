import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { hlcWall } from "@/lib/hlc";
import { formatEdited, selectNotebooks } from "@/lib/library";
import { addTextBox, createNotebook, lastEditedTimes, liveSections, newEntity, putEntities, setDeleted } from "@/lib/store";
import type { Entity, NotebookEntity, PresenceData, StrokeData } from "@/lib/types";

const live = vi.hoisted(() => ({ values: [] as unknown[], call: 0 }));
vi.mock("@/lib/sync", () => ({ requestSync: vi.fn() }));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => live.values[live.call++ % 4] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));
import Library from "@/components/Library";

const T0 = Date.UTC(2026, 10, 18, 9, 0);
const stamp = (ms: number, device = "remote") => `${String(ms).padStart(13, "0")}-0000-${device}`;
const stroke = (notebookId: string, sectionId: string) =>
  newEntity<"stroke", StrokeData>("stroke", notebookId, sectionId, { tool: "pen", color: "#000", size: 2, pts: [0, 0, 0.5, 0, 0, 0], t0: 0, input: "pen", device: "here" });

// The hybrid logical clock never runs backwards within the module, so each test starts later.
let T = T0;
beforeEach(async () => {
  await db.entities.clear();
  await db.events.clear();
  T += 10 * 86_400_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("notebook last-edited time", () => {
  it("starts at creation and moves with local stroke, text box, section and delete writes", async () => {
    const id = await createNotebook("Physics");
    expect((await lastEditedTimes()).get(id)).toBe(T);
    const [section] = await liveSections(id);

    vi.setSystemTime(T + 60_000);
    const [s] = await putEntities([stroke(id, section.id)]);
    expect((await lastEditedTimes()).get(id)).toBe(T + 60_000);

    vi.setSystemTime(T + 120_000);
    await addTextBox(id, section.id, 10, 10);
    expect((await lastEditedTimes()).get(id)).toBe(T + 120_000);

    vi.setSystemTime(T + 180_000);
    await setDeleted([s.id], true); // erasing restamps the stroke
    expect((await lastEditedTimes()).get(id)).toBe(T + 180_000);
  });

  it("keeps notebooks apart and ignores presence (scrolling is not editing)", async () => {
    const a = await createNotebook("A");
    vi.setSystemTime(T + 5_000);
    const b = await createNotebook("B");
    vi.setSystemTime(T + 90_000);
    const presence = newEntity<"presence", PresenceData>("presence", a, "", { device: "here", deviceKind: "desktop", sectionId: null, offsetY: 0, at: T + 90_000 }, "presence-here");
    await putEntities([presence]);
    const times = await lastEditedTimes();
    expect(times.get(a)).toBe(T);
    expect(times.get(b)).toBe(T + 5_000);
  });

  it("uses the writer's stamp for rows applied by sync, so a pull moves it to the edit time", async () => {
    const id = await createNotebook("Shared");
    const [section] = await liveSections(id);
    vi.setSystemTime(T + 600_000);
    // What syncOnce stores for a newer remote row: the server's copy with its original hlc.
    const remote: Entity = { ...stroke(id, section.id), hlc: stamp(T + 300_000), dirty: 0 };
    await db.entities.bulkPut([remote]);
    expect((await lastEditedTimes()).get(id)).toBe(T + 300_000);
  });

  it("skips deleted notebooks and falls back to createdAt for rows without a stamp", async () => {
    const id = await createNotebook("Gone");
    await setDeleted([id], true);
    const legacy = { ...newEntity("notebook", "legacy", "", { title: "Old", createdAt: 42 }, "legacy"), hlc: "", dirty: 0 as const };
    await db.entities.put(legacy);
    const times = await lastEditedTimes();
    expect(times.has(id)).toBe(false);
    expect(times.get("legacy")).toBe(42);
  });

  it("parses wall time from stamps", () => {
    expect(hlcWall(stamp(T, "dev"))).toBe(T);
    expect(hlcWall("")).toBeUndefined();
    expect(hlcWall("garbage")).toBeUndefined();
  });
});

const nb = (id: string, title: string, createdAt: number) => ({ id, data: { title, createdAt } }) as NotebookEntity;

describe("recently edited sort and label", () => {
  const notebooks = [nb("a", "Old but busy", 1), nb("b", "New but idle", 3), nb("c", "Untouched", 2)];
  it("orders by last edit, falling back to createdAt, with stable ties", () => {
    const edited = new Map([["a", 100], ["b", 3]]);
    expect(selectNotebooks(notebooks, "", "recent", edited).map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(selectNotebooks(notebooks, "", "recent").map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(selectNotebooks(notebooks, "", "recent", new Map([["a", 5], ["b", 5]])).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
  it("formats relative times, treating a clock ahead of ours as just now", () => {
    const m = 60_000, h = 60 * m, d = 24 * h;
    expect(formatEdited(T0 + 5_000, T0)).toBe("Edited just now");
    expect(formatEdited(T0 - 30_000, T0)).toBe("Edited just now");
    expect(formatEdited(T0 - 5 * m, T0)).toBe("Edited 5 min ago");
    expect(formatEdited(T0 - 3 * h, T0)).toBe("Edited 3 h ago");
    expect(formatEdited(T0 - 30 * h, T0)).toBe("Edited yesterday");
    expect(formatEdited(T0 - 4 * d, T0)).toBe("Edited 4 days ago");
    expect(formatEdited(T0 - 10 * d, T0)).toBe(`Edited ${new Date(T0 - 10 * d).toLocaleDateString()}`);
  });
  it("defaults the library to Recently edited and shows the label on cards", () => {
    live.call = 0;
    live.values = [[nb("a", "Algebra", T0 - 3_600_000), nb("b", "Biology", T0 - 60_000)], new Map(), undefined, new Map([["a", T0 - 5 * 60_000]])];
    vi.setSystemTime(T0);
    const html = renderToStaticMarkup(createElement(Library));
    expect(html).toMatch(/<option value="recent" selected="">Recently edited<\/option>/);
    expect(html).toContain("Edited 5 min ago");
    expect(html).toContain("Edited 1 min ago");
    expect(html.indexOf("Biology")).toBeLessThan(html.indexOf("Algebra"));
  });
  it("shows a placeholder until edit times load", () => {
    live.call = 0;
    live.values = [[nb("a", "Algebra", T0)], new Map(), undefined, undefined];
    expect(renderToStaticMarkup(createElement(Library))).not.toContain("Edited");
  });
});
