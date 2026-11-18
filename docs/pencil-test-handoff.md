# Pencil recording, replay and regression tests: handoff

Status after stage 3 (2026-11-18), branch `t3/pencil-replay-regression-harness`. **None of this has
been tested on an iPad or with an Apple Pencil.** Every recording checked in is synthetic.

## What exists

| Piece | File | What it does |
| --- | --- | --- |
| Controller hooks | `src/ink/controller.ts` | `InkPointer` (the event fields the controller reads), `onInput` (every input reaching `down/move/up/lostCapture/grab`, before filtering), `onCommit`, `onDiscard` (stray-dot filter threw a gesture away), and `ControllerOptions` `{ persist, now, device }`. With `persist: false` nothing reaches the store, undo or the event log. With no overlay canvas attached, the controller doesn't schedule frames or build `Path2D`s, so it runs in Node. |
| File format | `src/ink/recording.ts` | `padsync.pencil-recording` v1: the controller's inputs in order (`seq`), raw client samples (unrounded `clientX/Y`, `timeStamp`, `pressure`, `altitudeAngle`, `azimuthAngle`, tilt, twist, width/height when present), `coalesced` / `predicted` sample lists per move, the section rect and zoom for each event, the tool when it changes, and `committed`, the strokes the controller made while recording. `parseRecording` / `validateRecording` check size, JSON, schema and cross-references, and errors name the field (`events[3].sample.pressure: …`). Parsed recordings are deep-frozen. |
| Recorder | `src/ink/recorder.ts` | `PencilRecorder`: plug `input` / `commit` into the controller callbacks, then `finish()`. |
| Replay engine | `src/ink/replay.ts` | `PencilReplayer`: feeds events back through the same controller entry points, stepped, run to the end, or played at the recorded pace × speed (with an injectable `Scheduler`). Section coordinates are kept when the live section sits somewhere else or at another zoom. |
| Harness | `src/ink/replay-harness.ts` | `runReplay(rec, opts)` → `ReplayReport` (below). `replayStrokes`, `baselineOf`, `compareBaselines`. Options: `tool`, `pen` (pen parameter overrides to try a writing change), `useCoalesced`, `usePredicted`, `includeSvg`. |
| Pencil lab | `/pencil-lab` (`src/components/PencilLab.tsx`), linked from Settings → Troubleshooting | Record, Save file, Load file, Replay (0.25×/1×/4×, pause/resume), Replay at once, Clear, and the headless report with Copy JSON. Uses the notebook's saved pen settings (read only). Nothing is written to a notebook. |
| Synthetic generator | `tests/helpers/synthetic-pencil.ts`, specs in `tests/helpers/pencil-fixtures.ts` | Generates Pencil-like input (240 Hz samples coalesced into 60 Hz moves, 2 predicted samples per move, pressure ramps, tilt drift) and captures it through the real controller and `PencilRecorder`. Output is marked `source: "synthetic"` and labelled `SYNTHETIC: …`. |
| Fixtures | `tests/fixtures/pencil/*.pencil.json` and `baselines/*.baseline.json` | `synthetic-words`, `synthetic-zoomed-two-sections`, `synthetic-edge-cases` (cancel, lost capture with a late up, a finger, a bounce, a slow stroke with tilt changes, a mouse stroke, a stroke still open at stop). Real: `ipad-handwriting-2026-11-18`, 66 pen strokes on the iPad lab at 98% zoom, the sentence "Both pages now ignore scrolling for Pencil touches on the writing area" (light pressure, peak 0.19–0.35); `ipad-math-2026-11-18`, 217 strokes of maths working (colons, exponents, fractions). |
| Tests | `tests/pencil-replay.test.ts`, `tests/pencil-regression.test.ts`, `tests/pencil-fixtures.test.ts` | `npm run test:pencil` (31 tests; they also run in `npm test`). |

## The report (what you can measure)

`runReplay` replays through a real headless `InkController`, then puts each stored stroke through
the render pipeline (`toInput` clean-up → perfect-freehand outline → the SVG path the library uses).

- `recording`: event counts by type and pointer type; dispatched / coalesced / predicted sample
  counts; gestures (downs, ups, cancels, lost captures); the median pen sample interval from the
  browser's timestamps.
- `strokes[]`, one per stored stroke: points; duration; pressure / altitude / azimuth ranges; box;
  raw polyline length; `processed` (points after clean-up, length, `startGap` / `endGap`, which is how far
  the drawn line starts or ends from where the pen did, so cut-off letter parts show up here, and
  max/mean deviation from the raw line); `outline` (dot or outline, outline point count, and the
  SVG path with `includeSvg`).
- `discarded`: gestures the stray-dot filter removed.
- `fingerprint` (the stored ink) and `outlineFingerprint` (the drawn outlines): equal means the
  output is identical.
- `capture`: whether the replay reproduces what the controller committed while recording, with
  differences listed. A mismatch on an unmodified recording means the controller changed, or the
  replay isn't faithful.
- `performance`: wall time of the headless pipeline **in the process running it**. It is not
  touch-to-ink latency and is never written to baselines. A web page can't measure physical
  latency (Pencil contact → photons). That needs a high-speed camera or similar, on the device.

## Capturing a real session (needs the iPad; not done yet)

1. Run the app where the iPad can reach it (deployed, or `npm run dev` on the LAN), and open
   Settings → Troubleshooting → Pencil lab (`/pencil-lab`) in Safari or the home-screen app.
2. Type a label for what you'll write, e.g. "alphabet, light pressure", and add notes (iPad model,
   Pencil model, what looks wrong). Tap **Record**, write, then tap **Stop**.
3. Check the report card. Replay vs capture should say "identical". Then tap **Save file**: Safari
   downloads `pencil-<label>-<time>.json` to Files.
4. Copy the file to the Mac (AirDrop or Files). To make it a regression fixture, put it in
   `tests/fixtures/pencil/` (a `.pencil.json` name is fine but optional), run
   `PENCIL_UPDATE_BASELINES=1 npm run test:pencil`, and commit both the recording and the new
   baseline. Real recordings are `source: "device"`. Keep them apart from the synthetic ones by name
   (e.g. `ipad-alphabet-light.pencil.json`).
5. **Load file** in the lab reads any saved recording, and Replay draws it back on screen through the
   live controller, at the recorded pace.

Recordings contain the browser user agent, viewport size and the recorder's timestamps, and nothing
else about the device. A notebook's existing ink is not included: the lab has its own surface.

## Running regression tests

```sh
npm run test:pencil                                      # check every fixture against its baseline
PENCIL_UPDATE_BASELINES=1 npm run test:pencil            # accept current output as the baselines
PENCIL_RECORDINGS=~/Downloads/rec.json npm run test:pencil   # also replay these files/folders (comma-separated); prints a summary, no baseline needed
PENCIL_REPORT_DIR=/tmp/pencil npm run test:pencil        # write full reports (with SVG outlines) per recording
PENCIL_WRITE_FIXTURES=1 npm run test:pencil              # regenerate the synthetic fixtures from their specs
```

Workflow for a writing change (filters, pen defaults, controller): make the change, run
`npm run test:pencil`, and read the baseline diff it prints, e.g.
`strokes[3].processed.endGap: 0 → 1.8`. Decide whether that is better. If it is, update the
baselines in the same commit and say why. To compare options without editing code, call
`runReplay(rec, { pen: { … } })` from a test.

## What the first iPad recording showed

- iPadOS Safari reports Pencil `clientX/Y` on a 0.5 CSS px grid (device pixels at DPR 2), for
  dispatched and coalesced samples alike. On a fast, steep stroke the samples are 1.5–2.5 units
  apart, so the 1.5-unit position smoothing still leaves a faint staircase; a wider sigma
  (2–3) did not reduce measured wobble and doubled the distance from the pen.
- Replay matches capture exactly; no stroke was discarded; drawn centre lines stay within ~1 unit
  of the pen (mean 0.19) and no stroke end is cut (`startGap`/`endGap` 0).
- Coalesced samples arrive at ~4 ms (240 Hz); about 1.7 coalesced samples per dispatched move.
- Every stroke starts with 1–11 samples (median ~29 ms) at pressure exactly 0.08 (float32), coalesced
  samples included: Safari's placeholder estimate, never corrected. `smoothPressure` gives these the
  first real reading (`PLACEHOLDER_PRESSURE` in `src/ink/filters.ts`). The pen moves a median 1.8–2
  units (up to 16.5) during them.
- The pointerup sample (pressure 0) lands a median 3.3–3.6 units (p90 6–6.5) past the last move,
  about 4× a normal step, and is drawn at the held pressure: a short full-width flick at the end of
  most strokes, and much of the i-dot "ticks" below.
  It is not where the pen was heading: it turns more than 90° back against the stroke in about
  half of all strokes (median turn 80°), so every stroke ends in a small hook, and the stroke's end
  jumps a median 3 units when the pen lifts (the live stroke ended at the last move). Pen settings →
  Clean-up → "Ignore the lift-off point" (`dropLiftOff`, `withoutLiftOff` in `src/ink/filters.ts`)
  leaves it out at render time. It is off by default because it shortens each stroke by that last
  segment. Turned on, the end no longer jumps (median 0) and hooks such as an "=" bending into a "2" go.
- Maths recording: all colon dots become round dots, with their lift-off slides hidden. Two
  i-dots ("info", the second in "minimize") draw as 9-unit ticks: a landing drag at pressure
  0.08, a 4-unit firm tick and a 4.6-unit fading lift-off slide. At thinning 0.3 a light writer's
  whole pressure range (0.08–0.2) gives almost the same width (0.37–0.41 × size), so the drags
  draw at full weight. Pressure relative to each stroke's own level thins them only a little,
  because smoothPressure's 20 ms average and 0.03 step limit hold the pressure up through a quick fade.

## Limitations and open questions

- **No real-device verification.** Nothing has been checked yet:
  - that WebKit's `getCoalescedEvents` / `getPredictedEvents` on iPadOS behave as the generator
    assumes (the dispatched sample is the last coalesced one, and predictions are a few samples ahead);
  - that the lab's surface (`.ink-surface`, `touch-action: pan-x pan-y`) behaves like a notebook
    section with Scribble on, and that palm rejection works;
  - that **Save file** downloads from the home-screen web app, which may need the Safari tab;
  - the recorded / replayed "identical" check on a real recording.
- Recording happens at the controller, after React's handlers, so it records what the pipeline
  received, not every DOM event. Events the controller is never given (touch events, pointer
  events outside a section, `pointerrawupdate`) are not recorded. An earlier, uncommitted design
  (worktree `t3-69edc0ba…`, `src/ink/recording/`) captured everything on `window` with capability
  detection. It was not merged here, because its format is different and it has no replay.
- The lab records only on its own page. Recording inside a real notebook (`SectionView` already
  passes the section handle to `up`) would mean attaching a `PencilRecorder` to
  `NotebookEditor`'s controller callbacks behind a debug switch.
- Synthetic fixtures check the mechanics (order, timing, coalesced/predicted handling,
  cancellation, coordinates, determinism). They say nothing about how real handwriting looks:
  regressions in writing *quality* need real recordings.
- `next build` was not run in this worktree: Turbopack rejects the `node_modules` symlink outside
  the project root. `npm run typecheck`, `npm run lint` and `npm test` pass.

## How this stage relates to stages 1 and 2

When this stage ran, stages 1 and 2 were still running in their own worktrees with nothing
committed. This branch took a snapshot of stage 2's uncommitted `controller.ts` / `SectionView.tsx`
changes and `recording.ts`, `recorder.ts` and `replay.ts` from
`/Users/weiheng/.t3/worktrees/padSync/t3-7bcac6df-93d6f9b57cb09cd9` (state as of ~17:27). On top of
that it added:

- `onDiscard` and the `device` option, plus the headless guards, in the controller;
- `device: "replay"` in `replayHeadless`;
- the harness, the lab page, the generator, the fixtures, the tests and this doc.

When stage 2 lands, reconcile `src/ink/{controller,recording,recorder,replay}.ts` with it. The
harness relies only on `PencilReplayer`, `diffStrokes`, `recordingDuration`, the recording types,
and the controller callbacks and options above.
