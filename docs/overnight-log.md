# Overnight log

Each overnight run (00:00–06:00, every 30 min) appends an entry: what changed, what was checked,
what's next. Runs commit to local `main`; the 06:00 run pushes.

## 2026-11-19 00:00 — handwriting: Safari's placeholder pressure

**Changed.** `smoothPressure` (`src/ink/filters.ts`) no longer starts from Safari's placeholder.
Both iPad recordings show every Pencil stroke opening with 1–11 samples at exactly 0.08 (float32),
median ~29 ms: iPadOS's estimated pressure, which Safari never corrects. The filter used that value
as its starting point and then climbed slowly (20 ms average, 0.03 step cap), so stroke starts and
taps were drawn from the estimate. Now the leading placeholder run takes the first real reading,
which also seeds the average. A stroke with nothing but placeholders keeps them. No ink is removed
or moved; only widths change. Live and committed ink stay consistent: the live stroke changes once,
when the first real reading arrives (~30 ms in), and matches the committed stroke from then on.

**Measured** (scratchpad renders through `strokeSvgPath`, before vs after):
- Changed outlines: 66/66 strokes (handwriting), 216/217 (maths); stored ink unchanged
  (`fingerprint` same, only `outlineFingerprint` moved); synthetic fixtures unchanged.
- Start width / mid-stroke width: 0.948 → 0.966 (handwriting), 0.946 → 0.958 (maths); the most
  any start widened is 11.5%. Tap dots: radius up to +6% (0.84 → 0.88, 0.87 → 0.92); two got
  0.01 smaller.
- Pixel diff of rendered crops: 0.23% / 0.48% of ink pixels change, all slightly fuller stroke starts.
  The visible effect at thinning 0.3 is small. The main point is that pressure-based width work
  now starts from real readings.
- Checks: `npm run typecheck`, `npm run lint`, `npx vitest run` (778 passed), `npm run test:pencil`
  (33 passed). iPad baselines updated for the outline change.

**Needs a device check.** That the start of a stroke doesn't visibly "pop" when the first real
reading arrives (expected to be invisible: under ~4% width), and that tap dots look right.

**Next.**
1. Lift-off flick: the pointerup sample (pressure 0) lands a median 3.3–3.6 units past the last move
   (p90 6–6.5), ~4× a normal step, and draws at the held pressure with a round cap. That's a short
   full-width flick on most stroke ends, and part of the i-dot ticks. Without removing ink, it could
   draw thinner (taper the last segment, or give the up sample a falling pressure) instead of at
   full weight. Measure with the up-segment script idea: last-segment length vs the steps before it.
2. Width relative to each stroke's own level (candidate 3): at thinning 0.3 the whole light-writer
   range only moves the width ~10%, so the i-dot drags can't get thinner through `thinning` alone.
   That needs an end-specific width factor, not a remap of the whole stroke.
3. Curve fitting for the 0.5 px grid (candidate 1): not started; the handoff says a wider Gaussian
   didn't help.
