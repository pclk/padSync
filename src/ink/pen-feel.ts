// Pen feel: the user-adjustable smoothness and pressure sensitivity of pen strokes. Each stroke
// stores the values it was drawn with, so changing them never restyles existing ink.

/** Pen feel defaults, used for strokes drawn before the feel was stored and for new tool state. */
export const DEFAULT_SMOOTHING = 0.5;
export const DEFAULT_SENSITIVITY = 0.4;

/**
 * perfect-freehand settings for a pen feel. Smoothness (0–1) trades corner sharpness for calm
 * lines: streamline lags the line behind the tip, so too much of it melts the corners of an x or
 * a 4. Sensitivity (0–1) is how much pressure changes the width; Pencil pressure drifts with
 * grip and speed, so a low value keeps handwriting even.
 */
export function penFeel(smoothing = DEFAULT_SMOOTHING, sensitivity = DEFAULT_SENSITIVITY) {
  const s = Math.min(1, Math.max(0, smoothing));
  const p = Math.min(1, Math.max(0, sensitivity));
  return { streamline: 0.1 + 0.5 * s, smoothing: 0.35 + 0.4 * s, thinning: 0.75 * p };
}
