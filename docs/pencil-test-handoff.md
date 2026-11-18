# Pencil test interface — handoff

Goal over three stages: record Apple Pencil input, save it to files, replay it so coding assistants
can run tests against real writing and improve the pen.

## Status (2026-11-18, branch `t3/pencil-session-import-export-replay`)

Stage 1 (recording + schema) had no committed work when Stage 2 started (its branch
`t3/pencil-input-recording-interface` was identical to `main`), so Stage 2 built both.

**Done**
- `src/ink/recording.ts` — file format `padsync.pencil-recording` v1: types, zod validation, cross-checks,
  `parseRecording` / `serializeRecording`, deep-frozen result, size limits.
- `src/ink/recorder.ts` — `PencilRecorder`, attached through the controller's `onInput` / `onCommit` callbacks.
- `src/ink/replay.ts` — `PencilReplayer` (play / pause / restart / speed / step / stepTo / runToEnd, injectable
  scheduler), `replayHeadless` (no page), `diffStrokes`.
- `src/ink/controller.ts` — takes `InkPointer` (the PointerEvent fields it reads) instead of `PointerEvent`.
  Added the `onInput` / `onCommit` callbacks and `ControllerOptions { persist, now }`. `up()` takes the section
  as an optional second argument, used only for recording. Live behaviour is the same otherwise.
- `/pencil-lab` (`src/components/PencilLab.tsx`, linked from Settings → Diagnostics) — scratch page: Record,
  Save file, Open file (errors shown), Replay with Play/Pause, Restart, Step, To end, speed 0.25–4×, and
  Verify (a headless exact comparison). Lab strokes are never stored (`persist: false`).
- `tests/pencil-replay.test.ts` and `tests/fixtures/pencil/synthetic-hi.json`. The fixture is **synthetic**
  (`source: "synthetic"`), not hardware input. Regenerate it with `WRITE_PENCIL_FIXTURES=1 npx vitest run tests/pencil-replay.test.ts`.

**Not done / not verified**
- **No hardware testing.** Nothing has been recorded on a real iPad and Pencil yet, and the lab page hasn't been
  run in a browser, only built (`next build`) and type-checked. Stage 3 should record real sessions on the device.
- Recording is only in the lab, not inside the notebook editor (only lab input reaches a recorder).
- Fingers, the eraser and the lasso are recorded and replayed. With `persist: false`, erase and drag change nothing,
  and grab replay only matters if a lasso selection was replayed first.

## Format (v1)

```
{ format, version: 1, id, label, notes?, createdAt (ISO), source: "device"|"synthetic",
  environment { userAgent, platform?, maxTouchPoints?, devicePixelRatio, viewport },
  pageWidth, timeOrigin (first event timeStamp), sections [{id,width,height}],
  events [{ seq, kind: down|move|up|lost|grab, type: pointerdown|pointermove|pointerup|pointercancel|lostpointercapture,
            section, pointerId, pointerType, button, buttons, rect{left,top,width,height}, zoom,
            sample, coalesced?, predicted?, tool? }],
  committed? [{ afterSeq, sectionId, data: StrokeData }] }
sample = { timeStamp, clientX, clientY, pressure, altitudeAngle?, azimuthAngle?, tiltX?, tiltY?, twist?, width?, height?, tangentialPressure? }
```
- The recorder doesn't round or reorder samples. Events are in delivery order (`seq` = index). Cancellations
  (`pointercancel`) and lost capture are separate events.
- `tool` is stored on the first event and whenever the tool changes. `committed` is what the controller produced
  while recording: use it as the expected output for regression tests.
- Limits: 25 MB file, 200k events, 256 samples per event list, 1M samples in total, 200 sections, 20k
  committed strokes. Error messages name the field, e.g. `events[2].sample.pressure: …`. Unknown fields are dropped on parse.

## How replay works

The replayer builds plain `InkPointer` objects (not DOM events) and calls the controller's own
`down` / `move` / `up` / `lostCapture` / `grab`, the same calls the section's pointer handlers make. Raw timeStamps
pass through unchanged. Coordinates:
- They pass through unchanged when the target section is at the recorded rect and zoom, so the output is exact.
- Otherwise they're remapped onto the target section, keeping section coordinates. The mapping is fixed at each
  gesture's down, like the controller's own rect.

The replay's `StrokeData.t0` comes from `createdAt` plus the event's offset, so it's deterministic. Imported
recordings are frozen, `restart()` calls `host.reset()` (a fresh controller), and repeated replays give
identical output (tested).

## For Stage 3

- Record real sessions in `/pencil-lab` on the iPad, save them into `tests/fixtures/pencil/` with `source: "device"`,
  and describe them in `notes`. The fixture test then replays every file there and compares it with `committed`.
- Comparing to `committed` checks that replay is deterministic, not that the writing is good. To work on writing
  quality, replay fixtures with changed pen params (`replayHeadless(rec, InkController, { tool })`) and measure
  the output, e.g. with filters/render outline metrics.
- If pen processing changes on purpose, the old `committed` values will differ. Re-record the fixtures, or add
  expected outputs that are kept separately from the raw events.
- Optional: record inside the notebook editor by passing `PencilRecorder.input/commit` into its controller callbacks.

## Checks run

`npm run typecheck`, `eslint` on the changed files, `npx vitest run` (76 files, 722 tests passed, 2 skipped),
`next build` (`/pencil-lab` is static). The test worktree needed a real `npm ci`: Turbopack rejects a symlinked `node_modules`.
