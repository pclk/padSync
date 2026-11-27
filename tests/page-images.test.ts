import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/sync/route";
import { lassoImages, placeImage } from "@/lib/page-images";
import { withinBytes } from "@/lib/sync";
import { setSqlForTests } from "@/server/db";
import { PAGE_WIDTH, type ImageEntity } from "@/lib/types";
import { configureAuthEnv, freshDb, req, sessionCookie } from "./helpers/env";

afterEach(() => setSqlForTests(null));

const image = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, kind: "image", data: { x, y, w, h, src: "data:image/png;base64,AA" } }) as unknown as ImageEntity;

describe("placing a pasted picture", () => {
  it("keeps a copied area's size, centred where it was put", () => {
    expect(placeImage(400, 200, 500, 500)).toEqual({ x: 400, y: 450, w: 200, h: 100 });
  });

  it("is never wider than a column of the page, and stays on the page", () => {
    const p = placeImage(4000, 2000, PAGE_WIDTH, 0);
    expect(p.w).toBe(900);
    expect(p.x + p.w).toBe(PAGE_WIDTH);
    expect(p.y).toBe(0);
  });
});

describe("lassoing pictures", () => {
  const square = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pics = [image("in", 10, 10), image("edge", 180, 10), image("out", 500, 500)];

  it("touch takes pictures the loop crosses or holds", () => {
    expect(lassoImages(pics, square(0, 0, 200, 200), "touch").map((p) => p.id)).toEqual(["in", "edge"]);
    expect(lassoImages(pics, square(520, 520, 540, 540), "touch").map((p) => p.id)).toEqual(["out"]);
  });

  it("enclose takes only pictures whose centre is circled", () => {
    expect(lassoImages(pics, square(0, 0, 200, 200), "enclose").map((p) => p.id)).toEqual(["in"]);
  });
});

describe("sync with pictures in rows", () => {
  it("a push stops once its rows pass the size, but always sends one", () => {
    const rows = [{ d: "x".repeat(600) }, { d: "x".repeat(600) }, { d: "x".repeat(600) }];
    expect(withinBytes(rows, 1300)).toHaveLength(2);
    expect(withinBytes(rows, 10)).toHaveLength(1);
  });

  it("a pull page stops before its data passes 3 MB and says there is more", async () => {
    configureAuthEnv();
    const { sql, pg } = await freshDb();
    try {
      setSqlForTests(sql);
      const big = (i: number) => ({ id: `img${i}`, kind: "image", notebookId: "nb", parentId: "s", data: { x: 0, y: 0, w: 1, h: 1, src: "data:image/png;base64," + "A".repeat(900_000) }, hlc: `000000000000${i}-0000-other`, deleted: 0 });
      const call = async (body: unknown) => (await POST(req("/api/sync", { session: sessionCookie(), body }))).json();
      await call({ since: 0, changes: [big(1), big(2), big(3), big(4)], events: [] });
      const first = await call({ since: 0, changes: [], events: [] });
      expect(first.changes.map((c: { id: string }) => c.id)).toEqual(["img1", "img2", "img3"]);
      expect(first.more).toBe(true);
      const second = await call({ since: first.cursor, changes: [], events: [] });
      expect(second.changes.map((c: { id: string }) => c.id)).toEqual(["img4"]);
      expect(second.more).toBe(false);
    } finally {
      await pg.close();
    }
  });
});
