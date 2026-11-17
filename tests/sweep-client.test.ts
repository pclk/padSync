import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as syncRoute } from "@/app/api/sync/route";
import { db } from "@/lib/db";
import { sectionStats } from "@/lib/export";
import { hlcNow, hlcObserve } from "@/lib/hlc";
import { liveChildren, newEntity, putEntities, setDeleted } from "@/lib/store";
import { syncOnce } from "@/lib/sync";
import type { Entity, StrokeData, StrokeEntity } from "@/lib/types";
import type { Sql } from "@/server/db";
import { configureAuthEnv, freshDb, req, sessionCookie } from "./helpers/env";

// Optimization sweep, client side: the local store and sync engine against IndexedDB (fake) and
// the real sync route (PGlite).

let sql: Sql;
let session: string;
let requests: { changes: Entity[] }[] = [];

beforeAll(() => {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push(body);
    return syncRoute(req(url, { body, session }));
  });
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
  requests = [];
  await Promise.all([db.entities.clear(), db.events.clear(), db.meta.clear()]);
});

const strokeData = (over: Partial<StrokeData> = {}): StrokeData => ({ tool: "pen", color: "#000", size: 2, pts: [0, 0, 0.5, 1, 0, 0], t0: 1, input: "pen", device: "d", ...over });
const stroke = (id: string, parent = "s1") => newEntity<"stroke", StrokeData>("stroke", "nb", parent, strokeData(), id);

describe("hlc", () => {
  it("stays sortable past 9999 stamps in one millisecond", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    try {
      const stamps = Array.from({ length: 25_000 }, () => hlcNow("d"));
      for (let i = 1; i < stamps.length; i++) expect(stamps[i] > stamps[i - 1], `stamp ${i}`).toBe(true);
      expect(stamps.every((s) => /^\d{13}-\d{4}-d$/.test(s))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores malformed remote stamps", () => {
    const before = hlcNow("d");
    hlcObserve("garbage");
    hlcObserve("");
    expect(hlcNow("d") > before).toBe(true);
  });

  it("a rewrite sorts after the version it replaces even if the wall clock went back", async () => {
    const future = `${String(Date.now() + 3_600_000).padStart(13, "0")}-0000-other`;
    const [saved] = await putEntities([{ ...stroke("a"), hlc: future }]);
    expect(saved.hlc > future).toBe(true);
  });
});

describe("liveChildren", () => {
  it("returns only live rows of the kind, using the deleted index", async () => {
    await putEntities([stroke("a"), stroke("b"), stroke("c", "s2")]);
    await setDeleted(["b"], true);
    expect((await liveChildren<StrokeEntity>("s1", "stroke")).map((s) => s.id)).toEqual(["a"]);
    await setDeleted(["b"], false);
    expect((await liveChildren<StrokeEntity>("s1", "stroke")).map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});

describe("sectionStats", () => {
  it("counts focus events through the compound index", async () => {
    await db.events.bulkAdd([
      { id: "e1", notebookId: "nb", sectionId: "s1", type: "focus", t: 1, device: "d", data: {}, synced: 0 },
      { id: "e2", notebookId: "nb", sectionId: "s1", type: "stroke", t: 2, device: "d", data: {}, synced: 0 },
      { id: "e3", notebookId: "nb", sectionId: "s1", type: "focus", t: 3, device: "d", data: {}, synced: 0 },
      { id: "e4", notebookId: "nb", sectionId: "s2", type: "focus", t: 4, device: "d", data: {}, synced: 0 },
    ]);
    expect((await sectionStats("s1")).focusEvents).toBe(2);
  });
});

describe("sync engine", () => {
  it("pushes dirty rows, clears dirty, and marks events synced", async () => {
    await putEntities([stroke("a"), stroke("b")]);
    await db.events.add({ id: "e1", notebookId: "nb", sectionId: "s1", type: "x", t: 1, device: "d", data: {}, synced: 0 });
    expect(await syncOnce()).toBe(false);
    expect(await db.entities.where("dirty").equals(1).count()).toBe(0);
    expect(await db.events.where("synced").equals(0).count()).toBe(0);
    expect((await sql.query(`select id from entities order by id`)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps a row dirty if it was rewritten while the push was in flight", async () => {
    await putEntities([stroke("a")]);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const row = (await db.entities.get("a"))!;
      await putEntities([{ ...row, data: { ...(row.data as StrokeData), color: "#f00" } }]);
      return real(url, init);
    });
    try {
      await syncOnce();
    } finally {
      vi.stubGlobal("fetch", real);
    }
    expect((await db.entities.get("a"))!.dirty).toBe(1);
    await syncOnce();
    expect((await db.entities.get("a"))!.dirty).toBe(0);
    expect((await sql.query<{ data: StrokeData }>(`select data from entities where id = 'a'`))[0].data.color).toBe("#f00");
  });

  it("pulls remote rows and keeps a newer local copy", async () => {
    const [local] = await putEntities([stroke("mine")]);
    await syncOnce();
    const old = "0000000000001-0000-x";
    const newer = "9999999999999-0000-x";
    await sql.query(
      `insert into entities (id, kind, notebook_id, parent_id, data, hlc, deleted) values
       ('remote', 'stroke', 'nb', 's1', '{}'::jsonb, $1, false),
       ('mine', 'stroke', 'nb', 's1', '{"stale": true}'::jsonb, $2, false)
       on conflict (id) do update set hlc = excluded.hlc, data = excluded.data, seq = nextval('entity_seq')`,
      [newer, old],
    );
    await syncOnce();
    expect((await db.entities.get("remote"))?.hlc).toBe(newer);
    expect((await db.entities.get("mine"))?.hlc).toBe(local.hlc);
  });

  it("heals a write the server rejected by taking the server's version", async () => {
    const [mine] = await putEntities([stroke("a")]);
    await syncOnce();
    // Another device wrote a newer version; this device then writes from a lagging clock.
    const theirs = "9999999999999-0000-other";
    await sql.query(`update entities set hlc = $1, data = '{"theirs": true}'::jsonb where id = 'a'`, [theirs]);
    await db.meta.put({ key: "cursor", value: 1e9 }); // as if already past it
    await db.entities.put({ ...mine, hlc: "0000000000002-0000-me", dirty: 1 });
    await syncOnce();
    const row = (await db.entities.get("a"))!;
    expect(row.hlc).toBe(theirs);
    expect(row.data).toEqual({ theirs: true });
    expect(row.dirty).toBe(0);
  });

  it("does not download its own writes back", async () => {
    await putEntities([stroke("a"), stroke("b")]);
    const res = vi.fn();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const r = await real(url, init);
      res((await r.clone().json()).changes.length);
      return r;
    });
    try {
      await syncOnce();
    } finally {
      vi.stubGlobal("fetch", real);
    }
    expect(res).toHaveBeenCalledWith(0);
  });

  it("drains more than one batch", async () => {
    await putEntities(Array.from({ length: 150 }, (_, i) => stroke(`s${i}`)));
    expect(await syncOnce()).toBe(true);
    expect(await syncOnce()).toBe(false);
    expect(Number((await sql.query<{ n: string }>(`select count(*) as n from entities`))[0].n)).toBe(150);
    expect(requests[0].changes).toHaveLength(100);
  });
});
