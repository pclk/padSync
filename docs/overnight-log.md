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

## 2026-11-19 00:30 — zoom: pinch preview and commit agree

**Changed.** iPad pinch (`NotebookEditor` touch handler) now works out the end result once, with
the new pure `pinchPlacement` (`src/lib/notebook-viewport.ts`), and both draws the live transform
and commits from it. Before, the preview followed the fingers freely while the commit's
`scrollBy` was clamped by the browser. Three jumps came from that:
- **Pan limits.** Pinching or dragging past the left/right/top/bottom scroll limit showed the page
  out there, then snapped it back on lift-off. Now the preview stops at the limit (the page stays
  put while the fingers keep moving), as the commit will.
- **Zooming out to fit.** Once the page fits the strip, `columnLayout` centres it. The preview kept
  it under the fingers and the commit centred it. Now the preview centres it too.
- **At 300% / 25%.** Pinching further gave scale 1 exactly, `setZoom` bailed out with the same
  value, the anchor scroll never ran, and the two-finger pan snapped back. The commit is now
  `flushSync(setZoom)` then `scrollTo(placed)`, so a pure pan commits too.
- **Two-finger drags.** A 3% dead zone: two-finger drags only pan until the fingers spread or close
  by 3%, then the scale carries on from 1 (no jump). Pans no longer leave odd zooms like 100.4%
  behind, which re-rendered every section and repainted tiles.
- **Native scroll during the pinch.** The preview is measured from where the column sits now, so
  if Safari has already started scrolling with the first finger, the anchor still lands under the
  fingers.
- Simpler: the pinch no longer keeps two rects or goes through `zoomAt`'s anchor effect. Pinch logs
  its own `zoom` event. Ctrl+wheel and reset are unchanged.

**Checked.** 6 new tests in `tests/notebook-viewport.test.ts`: anchor stays under the midpoint in
open space, placement matches `columnLayout` at the new zoom, left/right pan limits, centring
when zoomed out to fit, top/bottom limits (the scroll range scales with the column), and pan-only
at the zoom limits. `npm run typecheck`, `npm run lint`, `npx vitest run` (784 passed). Stroke
drawing is untouched, so `test:pencil` wasn't needed.

**Sharpness review (no change).** Tiles repaint at `ceil(dpr·zoom·4)/4` capped at 2.95×, so on a
2× iPad, zoom above ~148% is slightly soft (memory cap). PDF rasters are capped at the screen
density (`pdfDensity` ≤ dpr), so PDFs above 100% are upscaled and soft. Raising either cap costs
iPad memory. Leave until a device check shows it matters.

**Needs a device check.**
- Pinch at the left/right limits at 150–300%, and zoom out to 25%: no snap on lift-off.
- Two-finger tap undo still works: the pan commit may move the page by a pixel or two of finger
  jitter.
- That the 3% dead zone doesn't feel sticky at the start of a pinch.
- Near the very bottom of a notebook, zooming out: the bottom limit is estimated (column height
  scales, "Blank page" button and bottom padding don't), so a small settle there is possible.
- Black blocks during a long pinch: the preview still transforms the whole column (`pinchRef`),
  the same tall-layer case the per-section scaling avoided at rest.

**Next.**
1. If black blocks show while pinching, transform only the sections near the viewport during the
   gesture (or hide off-screen ones), not the whole column.
2. Ctrl+wheel on the Mac could use `pinchPlacement` as well, to stop wheel zoom from drifting at the
   pan limits, and `zoomAt` could then go.
3. Sharpness above 150% (tile and PDF caps), if the device check shows softness.

## 2026-11-19 01:00 — bugs: pinch on a notebook shorter than the window

**Fixed.** The pinch preview (`pinchPlacement`) worked out the bottom scroll limit as the
document's scroll range at the start plus the column's growth. But the editor is
`min-h-screen`: when the notebook is shorter than the window (a few sections at 25–50%),
`scrollHeight` is the window height and the start range is 0 no matter how short the content is.
Pinching in near the bottom then let the preview scroll further than the browser allows, and the
page snapped back on lift-off. In the test case (one section at 25%, pinched to 50% and dragged
up) the preview scrolled to 258 px against a real limit of 156 px. `PinchStart` now carries the
notebook's own height (column bottom + bottom margin, read at pinch start) and the window height
instead of `maxScrollY`. For notebooks taller than the window the result is the same as before.

**Checked.** A new failing test first (`tests/notebook-viewport.test.ts`, "knows a short notebook
can only scroll…"), then the fix. `npm run typecheck`, `npm run lint`, `npx vitest run` (785
passed). Stroke drawing is untouched, so `test:pencil` wasn't needed.

**Reviewed, no bug found.** Today's `usePencilNoScroll` (surfaces mount unconditionally, so the
ref is set when the effect runs), the replay timer, the recorder, and the sync push/pull path
(server advisory lock and seq order, client ack only when the hlc is unchanged, LWW on pull).
Two minor things not worth a change: a truncated Pencil test recording has no `record-stop`
marker, because the recorder stops accepting events once the limit is hit. And a lasso move
writes back the strokes as they were at drag start, so a stroke erased on another device
*during* that one drag would come back.

**Needs a device check.** Zoomed out to 25% on a one- or two-section notebook, pinch in near the
bottom of the screen: the page should not settle back when the fingers lift. Also check that
`getComputedStyle(...).marginBottom` resolves the `max(50vh, …)` margin to px in iPad Safari (it
should; a 0 there would make the bottom limit too tight, not too loose).

**Next.** The 00:30 run's list still stands (Ctrl+wheel through `pinchPlacement`, black blocks
during long pinches, sharpness above 150%).

## 2026-11-19 01:30 — UI: a clearer Settings page

**Why Settings.** It was the screen where intent was least clear: the two Pencil tools sat under
different headings (Pencil test under Diagnostics, Pencil lab under Notebook) with no hint of how
they differ; "Layout · Starts in Auto by default · Idle delay" didn't say what the delay does;
sign-in sat below Sync even though sync needs it, and everyday settings (theme, notebook) were
mixed in between the long sync-timing and token cards.

**Changed** (`src/components/SettingsView.tsx`):
- Order is now Account and sync → Appearance → Notebook → (Sync timing, Mac bridge tokens when
  signed in) → NUS Canvas → Troubleshooting.
- Sign-in and sync status are one card: sign-in state first ("Sign in to sync notebooks between
  devices"), then the status rows and Sync now / Re-download everything.
- The idle slider moved into Notebook as "Auto layout: switch to chat after N s", with one line
  saying what Auto does with it.
- New "Troubleshooting" card holds the sync debug toggle and both Pencil tools, labelled by
  purpose: "Pencil test · what Safari sends" (raw events; start here to report a problem) and
  "Pencil lab · how padSync draws it" (record and replay through the pen). Page names and routes
  are unchanged.
- One small `Setting` row helper (title, hint, control) replaces four copies of the same markup.
- "Device tokens" heading is now "Mac bridge tokens". The Pencil test page's back button is a
  labelled "Settings" button like the Pencil lab's, not a bare icon.
- Handoff docs updated to point at Settings → Troubleshooting.

**Checked.** New `tests/settings-layout.test.ts` (section order, both Pencil tools in one card with
their purposes, idle-delay wording). Existing Settings tests (theme, copy buttons, sync debug
toggle) still pass. `npm run typecheck`, `npm run lint`, `npx vitest run` (788 passed). No stroke
code touched, so `test:pencil` wasn't needed.

**Needs a device check.** Settings on the iPad in portrait: the Troubleshooting rows' "Open"
buttons and the sign-in button stay on the right without squeezing the text; the Pencil test back
button still sits well in its wrapping header.

**Next (UI).** The notebook toolbar has the most controls on screen at once (layout segmented
control, pen settings, sync badge…); a later UI run could group or tuck away the less-used ones.
The two Pencil tools might merge into one page later: both save `padsync.pencil-recording` files, but from separate schema modules (`src/ink/recording.ts` and `src/ink/recording/schema.ts`), so check they really are one format first.
