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

## 2026-11-19 02:00 — handwriting: Safari's lift-off point

**Measured first.** The 00:00 run's next step 1 was the pointerup "flick". Both iPad recordings,
every pen stroke: the last point is the pointerup sample (pressure 0), a median 3.3–3.4 units
(p90 6) past the last move, 8–21 ms later. It is **not** the pen carrying on. It turns more than 90°
back against the stroke's direction in 30/65 (handwriting) and 98/212 (maths) strokes (median turn
80°, against 25–34° for the move before it). So it's iPadOS's estimate of where contact ended,
like the 0.08 placeholder pressure, and every stroke ends in a small hook. It also breaks live =
committed: the live stroke ends at the last move (plus predictions), and at lift the end jumps a
median 3.1 units (p90 5.5–6.2) to the hook.

Also checked and dropped: a falling-pressure fix for the end. At thinning 0.3 pressure 0.2 → 0
changes the width by only ~15% (0.41 → 0.35 × size, ~0.2 px at size 3), so pressure changes can't
remove the flick. Pressure-relative width is a change to how all ink looks, so I left it for you to decide.

**Changed.** New pen parameter `dropLiftOff`, Pen settings → Clean-up → "Ignore the lift-off point",
**off by default** (the rule: no ink removed by default). When on, `withoutLiftOff`
(`src/ink/filters.ts`) leaves the zero-pressure last point out at render time (`toInput` and the
tap-dot check in `dotCentre`). Stored points are unchanged, so it's reversible and applies to old
strokes drawn with it. Strokes under 3 points keep it. Like other Clean-up values, it's stored per
stroke only when it differs from the default.

**What it does when on** (scratchpad renders through `strokeSvgPath`, before/after): 65/66 and
207/217 outlines change; tap dots unchanged (1, 10). Visibly: the "=" in "V = …" no longer bends
into a "2", the tails on "goal", "pages", "7" and the "e" go, the ends of strokes read cleaner.
Live end → committed end: median 0 (p90 1.1–1.6) instead of 3.1. Cost: every stroke ends one
segment earlier (median 3.4 units), at the last point the Pencil pressed.

**Checked.** New tests in `tests/pencil-ends.test.ts` (default keeps it; on drops only a zero-pressure
last point; 3-point minimum; a tap with a long lift-off slide stays a dot when it's on).
`npm run typecheck`, `npm run lint`, `npx vitest run` (792 passed), `npm run test:pencil` (33 passed,
baselines unchanged because the default is unchanged). Latency: the default path only adds one boolean check
in `toInput`/`dotCentre`; nothing in `InkController` move/draw changed.

**Needs a device check / your decision.** Turn the toggle on, write, and see whether (a) strokes stop
"growing a hook" when the Pencil lifts, (b) nothing real is missing from letter ends (fast "c",
"s" endings, the tail of a "y"). The Pencil lab replays recordings with the notebook's pen settings,
so loading the two fixtures there shows the difference. If it looks right, making it the default is
a one-line change (`dropLiftOff: true` in `DEFAULT_PEN`) plus `PENCIL_UPDATE_BASELINES=1`.

**Next (handwriting).**
1. Decide the `dropLiftOff` default (above).
2. The 0.5 px staircase (curve fitting after lift): still not started.
3. i-dot ticks in "info"/"minimize": still lines (extent 9–10, landing drag at the placeholder
   pressure). `tapDot`'s spread check counts the landing drag too. Next step is to measure whether
   leaving placeholder samples out of `extent(-Infinity)` turns these into dots without turning short
   dashes (superscript minus) into dots.

## 2026-11-19 02:30 — feature: duplicate a lasso selection

**Checked first.** Lasso select, drag-to-move and delete already exist, and so does the page jump in
the side panel. What was missing was a way to copy ink, which you need for maths working (rewrite
the line above and change one term) and for repeated diagrams.

**Changed.**
- `InkController.duplicateSelection(sec)` (`src/ink/controller.ts`) copies the selected strokes as
  new strokes, 24 units down and to the right. `clampMove` keeps the copy on the page, so near an
  edge it is shifted less. The copy becomes the selection, so you can drag it straight into place.
  The originals are left alone. It's a single undo step, and undoing it also clears the copy's
  selection box. The event log gets `lasso_duplicate` (`from`, `ids`, `dx`, `dy`).
- The selection menu above the box (`src/components/SectionView.tsx`) is now Delete · Duplicate ·
  Done.
- Copies keep the stroke data exactly, pen overrides included, so the ink looks the same. Nothing
  is ever removed.

**Checked.** New tests in `tests/lasso-move.test.ts`: the copy is offset with new ids and the
originals are unchanged; the copy stays on the page at the bottom-right corner; undo, then redo;
a handle from another section is ignored. `npm run typecheck`, `npm run lint`, `npx vitest run`
(796 passed), `npm run test:pencil` (baselines unchanged; no rendering code touched).

**Needs a device check.** On the iPad: lasso some working, tap Duplicate, then drag the copy with
a finger. Check the three-button menu fits above a small selection near the page's left edge, and
that the copy appears straight away (it reaches the tiles through the live query, not the
pending-paint path).

**Next (features).** A keyboard shortcut (⌘D on the Mac) would need the editor to find the
selected section's handle, which is a small follow-up. Resizing the selection with a corner handle
is the other common lasso action that's still missing.

## 2026-11-19 03:00 — simplify: dead code and one download helper

**The two Pencil recording systems (checked, not merged).** They share only the `format` string
(`padsync.pencil-recording`, version 1) and a few lines. Underneath they are different data:
- `src/ink/recording.ts` (the Pencil lab) stores one object per controller event, with the section
  rect, zoom and tool, plus what the controller committed. Replay and the regression tests need
  exactly this shape, and both iPad fixtures are in it.
- `src/ink/recording/schema.ts` (the Pencil test) stores every pointer, touch and page event as
  column tuples, plus transform snapshots, capabilities and stats, and keeps fields that aren't
  exposed as null.
Merging them would mean converting one into the other (Pencil test → lab replay) or a third
format. That's new code, not less code, so I left them apart. One real catch for later: a Pencil
test file loaded into the Pencil lab, or the other way round, passes the format/version check and
then fails with field-level schema errors. The Pencil test format has `app.surface:
"pencil-test"`, so giving it its own `format` value (or reading `app.surface`) would let each page
say "that's a Pencil test file, open it in the Pencil test page" instead. That is a behaviour
change to the file format, so it's for a daytime run.

**Removed (unused anywhere in src, tests, bridge, scripts).**
- `replayHeadless` (`src/ink/replay.ts`): an older copy of the harness's `replayStrokes`, and its
  `ControllerClass` type.
- `PopoverCard` (`chat/Popover.tsx`), `hasHiddenAnswers` (`lib/blocks.ts`), `relativeImages`
  (`lib/schema.ts`), `isAuthed` (`server/auth.ts`).

**One download helper.** Five places built a Blob, made an `<a download>`, clicked it and revoked
the URL: Pencil lab Save, Pencil test Save, AI import "Download" prompt, returned-file download, and
chat "Export" conversation. They now call `downloadFile(name, body, type)` (`src/lib/download.ts`).
It uses the Pencil test page's version, which attaches the link to the page while clicking it and
keeps the URL for 10 s instead of 1 s. That's the safer version for iPad Safari's save sheet and
makes no difference elsewhere.

**Checked.** `npm run typecheck`, `npm run lint`, `npx vitest run` (796 passed),
`npm run test:pencil` (33 passed, baselines unchanged).

**Needs a device check.** On the iPad, one save of each kind still opens the save/share sheet:
Pencil lab Save and Pencil test Save at least.

**Not done (next simplify run).**
1. `NotebookEditor.tsx` (692 lines) and `Toolbar.tsx` (285): I didn't get to splitting them. The
   unused-export scan also listed many exports that are only used in their own file (such as
   `filters.ts` constants, `schema.ts` enums, `sync-policy.ts` timings). They aren't dead, but most
   could drop `export`. Low value, so I left them.
2. The format tag for the two Pencil file types (above).

## 2026-11-19 03:30 — zoom: one placement for pinch, Ctrl+wheel and reset

**Changed.**
- Mac Ctrl+wheel and the zoom reset button now go through `pinchPlacement`, like the iPad pinch
  (the 00:30 run's next step 2). `NotebookEditor` has one `measureZoom(anchor)` (the column and
  window now, shared with the pinch's touchstart) and one `commitZoom(placed)` (`flushSync`
  setZoom, then `scrollTo`, then the `zoom` log event). `zoomAt`, its `zoomAnchor` ref and the
  layout effect that applied the anchor are gone.
- A small bug this removes: Ctrl+wheel past 300% or 25% (or reset at the zoom you're already at)
  set the anchor but the zoom didn't change, so the effect never ran and the anchor stayed. The
  next zoom change from anywhere else (the Mac refitting when the side panel opens, for example)
  then applied the old scroll offset and logged a stray `zoom` event. Now nothing is committed
  when a wheel step doesn't change the zoom.
- The ink tile density formula moved from `SectionView` into `tileScale(zoom, dpr, quarterSteps)`
  in `src/ink/tiles.ts`, with `MAX_TILE_SCALE` (2.95) shared with the Pencil test page's canvas.
  Same numbers as before.

**Checked (density and memory, no change made).**
- Ink tiles on a 2× iPad: 0.5 at 25%, 2 at 100%, capped at 2.95 from ~148% up. Tiles span the
  page's full width, so at 300% most of each 37 MB tile is off screen sideways, and ink is drawn
  at about half the density the screen shows (2.95 against 6). Making it sharp would mean tiles
  split across the width too (a canvas at 6× and full width is ~38 MP, over iOS's ~16.7 MP limit).
  That's a larger change for a daytime run, and only worth it if the device shows the softness.
- At 25% each tile is ~1 MB, so the many tiles in view cost less than at 100%.
- PDF backgrounds stop at the screen density (`pdfDensity` ≤ dpr, `rasterScale` ≤ 2). Raising it
  to the 16 MP limit would only reach ~2.5× for a normal page (25% sharper) and costs ~60 MB per
  decoded page plus a slower PNG encode, so I left it.
- Following the iPad and position restore store offsets in page units and multiply by the
  current zoom, so they hold across different zooms on the two devices.

**Checked.** New tests: `tileScale` at 25–300%, the cap and the per-tile size
(`tests/zoom-memory.test.ts`); reset keeps the line under the header and the page's left edge;
30 Ctrl+wheel steps from 90% to 300% with the cursor near the right edge stay inside the pan limits
and keep the point under the cursor until the limit (`tests/notebook-viewport.test.ts`).
`npm run typecheck`, `npm run lint`, `npx vitest run` (802 passed), `npm run test:pencil`
(33 passed, baselines unchanged).

**Needs a device check.**
- Mac: trackpad pinch (Ctrl+wheel) in and out, and against the left/right edges at 200%+: no
  drift or jumps. Every wheel event now re-renders through `flushSync`; check that a fast trackpad
  pinch still feels smooth with a long notebook.
- Reset (the zoom % button) on both devices keeps the line under the header in place.
- iPad pinch is unchanged apart from the shared measuring code; a quick pinch at 25% and 300% to confirm.

**Next (zoom).**
1. Black blocks during a long iPad pinch (whole-column transform), if the device shows them.
2. Sharper ink above ~150%: tiles split across the width, so each canvas stays under the iOS limit.
3. Position save after a zoom that doesn't scroll the window (pinch at the very top): the scroll
   listener doesn't fire, so the saved offset waits for the next scroll. Small, not fixed.

## 2026-11-19 04:00 — UI: pen settings show the everyday sliders first

**Why the pen popover.** It opened on a "Quick" tab with five more tabs beside it (Line, Ends,
Clean-up, Pressure, Taps) holding 28 settings. "Quick" looked like one group among equals, so it
wasn't clear the two sliders are the settings most people need and the rest are for tuning, and
the 02:00 run had just added another clean-up setting.

**Changed** (`src/components/PenSettings.tsx`):
- The popover now opens on the preview, then Smoothness and Pressure, then one line ("Changes apply
  to new strokes. Pressure only affects the Apple Pencil.").
- Below that is a **Fine-tune** row (closed by default, 44 px tall to tap) that shows "28 settings",
  or "N changed" in the brand colour when any setting differs from the default. Opening it shows
  the five tabs (still with their changed dots) and their settings, and a note that the two sliders
  move several of these at once. The "Quick" tab is gone.
- The tab strip sticks to the top of the scrolling body, so it stays visible in long tabs.
- Whether Fine-tune is open is kept until the page reloads (one module variable), so someone tuning
  doesn't have to reopen it every time.
- No setting, default or stroke code changed; Reset all and per-setting Reset work as before.

**Checked.** New test in `tests/pen-feel.test.ts`: sliders come before and outside Fine-tune, it
starts closed with the setting count, and shows "2 changed" / "Reset all (2)" with two overrides.
The existing test (every setting still rendered) passes. `npm run typecheck`, `npm run lint`,
`npx vitest run` (803 passed), `npm run test:pencil` (33 passed, baselines unchanged).

**Needs a device check.** On the iPad: tap the pen twice, open Fine-tune, scroll a long tab
(Clean-up): the tab strip stays at the top with no gap or overlap, and scrolling inside the popover
doesn't scroll the notebook. Also check it in dark mode (the sticky strip uses `bg-white`, which the
dark palette remaps to the card surface).

**Next (UI).** The chat panel's controls (model picker, context picker, thread switcher) and the
library's empty state haven't been looked at yet. The notebook toolbar idea from 01:30 is still open.

## 2026-11-19 04:30 — bugs: duplicated ink painted under newer ink

**Fixed.** Lasso Duplicate (02:30) copied each stroke's `t0` along with its data. Strokes paint in
`t0` order (`paintStrokes`, and `paintDelta` for the tiles), so a copy sat at its original's
place in that order and was drawn **under** every stroke written after the original — including
the ink you duplicate it onto (visible where colours differ). The copies now take times just up
to now (`now - (n-1) … now`), in their originals' order, so they paint on top and keep their own
stacking. Point times are relative to `t0`, so durations and the stroke shapes don't change.
Side effect: the tile now adds the copy as a delta instead of repainting from scratch.

**Checked.** Failing test first in `tests/lasso-move.test.ts` (a copy must get a `t0` above a
stroke drawn after its original, and two copies keep their order), then the fix.
`npm run typecheck`, `npm run lint`, `npx vitest run` (804 passed), `npm run test:pencil`
(33 passed, baselines unchanged).

**Reviewed, no bug shown.** The zoom commit (`measureZoom`/`commitZoom`: `configure` runs in a
layout effect, so `controller.zoom` is current for the next wheel event after `flushSync`),
Ctrl+wheel at the limits, reset, `smoothPressure` placeholder edge cases (all-placeholder taps,
floor above 0.08), `withoutLiftOff` with `tapDot`/`dotRadius`, pen overrides with the new toggle
(`valid` accepts booleans), Pen settings Fine-tune state, and the shared `downloadFile`.

**Possible, not demonstrated (left alone).**
- Duplicate, then drag the copy before the live query has delivered it to `sec.strokes()`: the
  drag would move the box but not the ink. Needs a drag within ~tens of ms of the tap.
- Pinch: adding a third finger then lifting a different one continues the pinch with `d0` from
  the first pair, so the zoom could jump once.
- Section stats (`sectionStats`) count duplicated strokes as ink time.

**Needs a device check.** Duplicate some black working onto a line of blue writing: the copy
should be on top.

**Next (bugs).** The third-finger pinch case above is the most likely real one; it needs a test
harness for the touch handler (it lives in a `NotebookEditor` effect, not a pure function).

## 2026-11-19 05:00 — handwriting: review of tonight's changes

**Reviewed.** Both iPad recordings rendered in full at 3× (sharp + jiti, scratchpad) three ways:
the 6f106f9 pipeline (its `filters`/`render`/`pen-feel` copied out of git), the current default,
and the current default with "Ignore the lift-off point" on. I also made pixel diffs. Only two of
tonight's changes affect how ink looks: the placeholder pressure fix (00:00, on by default) and
`dropLiftOff` (02:00, off by default). Everything else under `src/ink` since 6f106f9 is recording,
replay or lasso code and doesn't change stored points.

- **Placeholder pressure: kept.** 0.34% / 0.39% of ink pixels change (slightly fuller starts), and
  you can't see it at 1×. No letter got worse.
- **`dropLiftOff`: toned down.** Always dropping the zero-pressure last point fixed the "3"→"8",
  "1152" dots and "+" ticks, but it also cut real fast tails: the "y" in "scrolling", the "g" in
  "writing", the "e" in "the" (13–15% of ink pixels changed). `withoutLiftOff` now drops the point
  only when it turns 90° or more against the stroke's last 2 units (the iPadOS estimate the 02:00
  run measured), or after a tap with no heading. A point that carries on forward is kept. With
  that, 29/66 and 91/217 strokes change (5–6% of ink pixels). The y/g/e tails stay, the 3/1152/+
  fixes stay, and tap dots are unchanged (1, 10). The "=" curls only partly go: those turn 45–80°,
  and 45°/60° thresholds cut the "e" tail again, so I kept 90°. Still off by default.
- **Simplify: nothing removed.** `tailTrim`/`hookTrim` (both off by default) partly overlap the
  lift-off option, but strokes may store overrides for them, and removing them would restyle that
  ink. I left them in place. A daytime decision: if `dropLiftOff` becomes the default after a
  device check, "Lift-off tails" is the candidate to retire.

**Checked.** New test in `tests/pencil-ends.test.ts` (a forward lift-off point is kept, a 90° turn
is dropped); the existing lift-off tests pass unchanged. `npm run typecheck`, `npm run lint`,
`npx vitest run` (805 passed), `npm run test:pencil` (33 passed, baselines unchanged because the
default is unchanged). Before/after summary added to `docs/pencil-test-handoff.md`.

**Needs a device check.** Toggle on: fast y/g/e/s/c endings are complete; 3, 8, + and = have no end
hooks. Then decide the default.

**Next (handwriting).** "=" curls (45–80° lift-off turns) need something other than a turn angle,
for example comparing the lift-off segment's length with the steps before it. The 0.5 px staircase
and the i-dot ticks are still open.

## 2026-11-19 05:30 — simplify: a lighter notebook startup

**Measured** (`npm run build`, then the chunks the notebook route loads). The shell every page
shares is 831 KB (242 KB gzipped: React, Dexie, the sync client) and didn't change. After it, the
notebook screen loaded 817 KB (250 KB gzipped). A one-off build with source maps split that up:
katex 261 KB, highlight.js 161 KB, **zod 110 KB**, marked 49 KB, html-to-image 12 KB, then our own
code. katex, highlight.js and marked draw the text sections, so they have to be there. zod and
html-to-image don't: zod is only used to check AI output, and html-to-image only to make an image.

**Changed.** zod reached the notebook through four imports, each of which only needed a small part:
- `store.ts` → `roundtrip.ts`, for the three-line `applyPatch`. `applyNotebookChanges` now loads
  `roundtrip` itself when you press Apply (it's already loaded by then, see the next item).
- `ReturnedFiles.tsx` → `roundtrip.ts`. "Show returned files" now loads the parser in parallel with
  the files request, and the review appears when both have arrived, as before.
- `context.ts` → `schema.ts`, for `SCHEMA_VERSION`. The constant moved to `types.ts`; `schema.ts`
  re-exports it, so other importers didn't change.
- `pdf.ts` → `pdf-meta.ts`, for `pdfSignature`. The zod `pdfMetadata` check is server-only (the
  `/api/pdfs` route), so it moved to `src/server/pdf-storage.ts`.
- `export.ts` now loads html-to-image inside `sectionPng`. "Copy image" still hands the clipboard
  its promise straight away, so Safari's user-gesture rule is unaffected.

Result: the notebook's own JS is 676 KB (208 KB gzipped), **−141 KB raw / −42 KB gzipped (−17%)**,
and the iPad parses and runs that much less before the first section draws. zod loads with the AI
import page (it needs it) or when you open returned files.

**Checked.** New `tests/startup-imports.test.ts` follows the editor's static imports and fails if
zod or html-to-image come back (I checked that it does fail when the old `store.ts` import is put
back). `npm run typecheck`, `npm run lint`, `npx vitest run` (806 passed), `npm run test:pencil`
(33 passed, baselines unchanged). No ink, stroke or drawing code changed.

**Looked at, left alone.** Nothing else from tonight is left unused: all the new exports are used,
and the Pencil test page's unrounded tile scale (next to `tileScale`) is on purpose. Loading
katex/highlight.js only when a section needs them would save more (~420 KB) but would make text
sections appear a moment after the page, which changes behaviour. That's a daytime decision.

**Needs a device check.** On the iPad: open a notebook, then in the side panel "Show returned
files" on an Ask job and Apply one change; and "Copy image" on a section still puts a PNG on the
clipboard.

**Next (simplify).** `NotebookEditor.tsx` / `Toolbar.tsx` splits (from 03:00) are still open. The
chat panel (~45 KB of our code) loads with the notebook before anyone opens it; loading it on first
open is the next startup win to measure.
