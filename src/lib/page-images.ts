import { pointInPolygon, type Box, type LassoMode } from "@/ink/geometry";
import { PAGE_WIDTH, type ImageData, type ImageEntity } from "./types";

// Pictures placed on a page (kind "image"): pasted on the web or the iPad, moved, resized and
// deleted with the lasso like ink. The picture rides in the row as a data: URL, so it is kept
// small: at most MAX_IMAGE_PX on its longer side and about MAX_IMAGE_SRC characters.

export const MAX_IMAGE_PX = 2400;
export const MAX_IMAGE_SRC = 1_100_000;
/** A pasted picture is at most this wide on the page, so there is room to write beside it. */
export const PASTE_MAX_W = 900;

export const imageBox = (d: Pick<ImageData, "x" | "y" | "w" | "h">): Box => ({ minX: d.x, minY: d.y, maxX: d.x + d.w, maxY: d.y + d.h });

/** Where a picture of `width` x `height` pixels goes when pasted centred on (x, y): at half its
 *  pixel size (a 2x screenshot keeps its on-screen size), at most PASTE_MAX_W wide, on the page. */
export function placeImage(width: number, height: number, x: number, y: number): Pick<ImageData, "x" | "y" | "w" | "h"> {
  const w = Math.max(24, Math.min(PASTE_MAX_W, width / 2));
  const h = (w * height) / Math.max(1, width);
  return { x: Math.round(Math.min(Math.max(0, x - w / 2), PAGE_WIDTH - w)), y: Math.round(Math.max(0, y - h / 2)), w: Math.round(w), h: Math.round(h) };
}

/** The pictures a lasso picks: "touch" takes any it crosses or that holds it, "enclose" those
 *  whose centre it circles. */
export function lassoImages(images: ImageEntity[], poly: number[][], mode: LassoMode): ImageEntity[] {
  if (poly.length < 3) return [];
  return images.filter(({ data: d }) => {
    if (pointInPolygon(d.x + d.w / 2, d.y + d.h / 2, poly)) return true;
    if (mode === "enclose") return false;
    const corners = [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]];
    return corners.some(([x, y]) => pointInPolygon(x, y, poly)) || poly.some(([x, y]) => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h);
  });
}

/** A clipboard picture as a data: URL small enough to sync (PNG for sharp text when it fits,
 *  else JPEG), with its size in pixels; null when it can't be read or made small enough. */
export async function encodeImage(blob: Blob): Promise<{ src: string; width: number; height: number } | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const k = Math.min(1, MAX_IMAGE_PX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const tries: [string, number?][] = [["image/png"], ["image/jpeg", 0.85], ["image/jpeg", 0.7], ["image/jpeg", 0.5]];
  for (const [type, q] of tries) {
    const src = canvas.toDataURL(type, q);
    if (src.length <= MAX_IMAGE_SRC) return { src, width: canvas.width, height: canvas.height };
  }
  return null;
}

/** Decoded pictures by src, for drawing them on a canvas (the drag preview, exports). */
const decoded = new Map<string, HTMLImageElement>();
export function imageElement(src: string): HTMLImageElement {
  let img = decoded.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    decoded.set(src, img);
    if (decoded.size > 64) decoded.delete(decoded.keys().next().value!);
  }
  return img;
}

/** The part of a picture inside `keep` (page units), as a data: URL small enough to sync. */
export async function cropImage(d: Pick<ImageData, "x" | "y" | "w" | "h" | "src">, keep: Box): Promise<string | null> {
  const img = imageElement(d.src);
  try {
    await img.decode();
  } catch {
    return null;
  }
  const sx = img.naturalWidth / d.w, sy = img.naturalHeight / d.h;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((keep.maxX - keep.minX) * sx));
  canvas.height = Math.max(1, Math.round((keep.maxY - keep.minY) * sy));
  canvas.getContext("2d")!.drawImage(img, (keep.minX - d.x) * sx, (keep.minY - d.y) * sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  return blob ? ((await encodeImage(blob))?.src ?? null) : null;
}
