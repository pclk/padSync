// The one place a pointer sample becomes a stored stroke point. The live controller and the Pencil
// test page (and recording replay) both go through it, so a recorded sample turns into exactly the
// point a real stroke would have stored.

/** The fields of a pointer event (or a recorded sample) that a stroke point is made from. */
export interface PointSource {
  pointerType: string;
  pressure: number;
  altitudeAngle?: number | null;
  azimuthAngle?: number | null;
  timeStamp: number;
}

const round = (v: number, f: number) => Math.round(v * f) / f;

/**
 * Appends one sample at section-local (x, y) to a flat STROKE_STRIDE point array. Returns false
 * when the sample is dropped: an exact repeat of the last position (pointerup often repeats the
 * last move), or, with dropOutOfOrder, older than the last stored sample (WebKit can hand an
 * earlier sample over again).
 */
export function appendPoint(pts: number[], x: number, y: number, ev: PointSource, t0: number, dropOutOfOrder: boolean): boolean {
  const n = pts.length;
  if (n && pts[n - 6] === round(x, 100) && pts[n - 5] === round(y, 100)) return false;
  if (dropOutOfOrder && n && Math.round(ev.timeStamp - t0) < pts[n - 1]) return false;
  const pressure = ev.pointerType === "pen" ? ev.pressure : 0.5;
  pts.push(
    round(x, 100),
    round(y, 100),
    round(pressure, 1000),
    round(ev.altitudeAngle ?? Math.PI / 2, 1000),
    round(ev.azimuthAngle ?? 0, 1000),
    Math.max(0, Math.round(ev.timeStamp - t0)),
  );
  return true;
}

/** Section-local coordinates of a client point: the section's rect origin, unscaled by zoom. */
export function toLocal(clientX: number, clientY: number, rect: { left: number; top: number }, zoom: number): [number, number] {
  return [(clientX - rect.left) / zoom, (clientY - rect.top) / zoom];
}
