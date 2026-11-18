# Pencil input recording — handoff

Goal (3 stages): a test interface that records Apple Pencil writing input, saves it to files, and
replays it so coding assistants can run test suites and improve writing.

## Stage 1 — done (2026-11-18)

Capture interface, recorder and versioned file format. **Not tested on a real iPad/Pencil**: only
unit tests with synthetic events, typecheck, lint and `next build`.

### Where things are

| Path | What |
| --- | --- |
| `src/ink/recording/schema.ts` | Format `padsync.pencil-recording`, `version: 1`. Types, column lists, zod validation, `parseRecording` (throws `RecordingFormatError`), `serializeRecording`, `recordingFileName`, `sampleValue`/`touchValue`. |
| `src/ink/recording/recorder.ts` | `PencilRecorder`: start/stop/reset, `pointer()`, `touch()`, `marker()`, `stats()`, `capabilities()`, `toRecording()`. No DOM wiring; it takes event-shaped objects, so tests (and replay) can feed it plain objects. |
| `src/ink/recording/capture.ts` | DOM wiring: capture-phase, passive listeners on `window` (`attachInputCapture`), `detectApis`, `captureEnvironment`, `surfaceTransform`. |
| `src/ink/samples.ts` | `appendPoint` / `toLocal`: the one path from a pointer sample to a stored stroke point. `InkController.addPoints` now uses it (behaviour unchanged), so replay can turn recorded samples into exactly the points a live stroke stores. |
| `src/components/PencilTestView.tsx`, `src/app/pencil-test/page.tsx` | `/pencil-test` page (linked from Settings → Troubleshooting, in the SW offline shell). |
| `tests/pencil-recording.test.ts` | Recorder, schema round trip/rejection, file names, shared point path. |

### Recording contents

- `events[]` in dispatch order (`seq`), recorded **before** app handlers: `pointer` (down, move,
  rawupdate where it exists, up, cancel, over/out, got/lostpointercapture, enter/leave of the surface),
  `touch` (start/move/end/cancel: `changed` tuples and `active` ids), `marker` (record-start/stop,
  visibilitychange, pagehide/show, window blur/focus, resize, orientationchange, scroll at most every
  100 ms, surface-reset when "Clear page" is pressed while recording).
- Pointer samples are tuples by `sampleFields` (`SAMPLE_FIELDS`): timeStamp, client/page/screen/offset
  XY, movementXY, pressure, tangentialPressure, tiltX/Y, twist, altitude/azimuth, width/height,
  button, buttons. Each pointer record has `sample` (the dispatched event), `coalesced`
  (getCoalescedEvents as returned: **observed**), `predicted` (getPredictedEvents: **not observed**);
  null list = API missing or it threw. Field missing/non-finite = `null`.
- Touch tuples by `touchFields`: identifier, touchType (1 stylus, 0 direct, null not exposed),
  positions, radiusX/Y, rotationAngle, force, altitude/azimuth.
- Per event: pointerId, pointerType, isPrimary, persistentDeviceId, modifiers bitmask, isTrusted,
  cancelable, `target` (`surface` | `ui` | `other`), `recv` (performance.now in the listener), `transform` id.
- `transforms[]`: stored only when changed. Surface-local = `((clientX - rect.left) / zoom, (clientY - rect.top) / zoom)`;
  surface is `pageWidth × pageHeight` (1376 × 720) units like a notebook section. Also dpr,
  scroll, viewport, visualViewport, preview canvas CSS/backing size.
- Header: id, createdAt, `timeOrigin` (t + timeOrigin = Unix ms), startT/stopT, `label`,
  `expectedText`, environment (UA, platform, maxTouchPoints, deviceKind, standalone, screen,
  pointer media queries, userAgentData), `tool` (color, size, pen overrides as strokes store them),
  `capabilities` (APIs; per pointerType each field `unavailable` | `constant` | `varies` with range,
  over observed samples only; `penUnavailable`; `notExposed`), `stats`, `truncated`, `limitations`.
- Limits: 150k events / 1M samples, then `truncated: true`.

### Test page behaviour

Start / Stop / Record again, Save (downloads JSON; enabled when stopped), Clear page, Reset, Open…
(validates a saved file and shows its stats/capabilities only). Ink preview uses the notebook's
palm rejection, `appendPoint`, stray-dot filter, `strokePath`/`paintStroke` and this device's saved
pen settings (`padsync.tool`); nothing is written to IndexedDB or synced. Feedback: status and
duration, counts (coalesced, predicted, strokes, ink kept/dropped, cancels, median pen interval →
Hz), last sample values, capability table, warnings (no pen seen, cancels, missing APIs, empty pen fields).
"Show samples" overlays observed (blue) and predicted (orange) points.

### Limitations to keep in mind

- Browser events, not sensor data; timestamps are `event.timeStamp`. Safari may leave fields such as
  twist/tangentialPressure absent or constant; check `capabilities` of a real recording before relying on them.
- `defaultPrevented` isn't recorded (listeners run before app handlers, so it would always be false).
- Only the test page records. The notebook editor isn't wired (attachInputCapture can be reused there
  with a resolver for the section under the event).
- Large recordings are held in memory and serialized at once.

## Next stages

**Stage 2 (replay + files)** — suggested:
1. `src/ink/recording/replay.ts`: pure function recording → `StrokeData[]` that mirrors
   `InkController` gesture rules (accept pen/mouse button 0 on `surface`; pointerdown starts; moves use
   `coalesced ?? [sample]`; up adds the final sample; cancel/lostpointercapture/buttons===0 end without
   it; `isStrayDot` drop) through `appendPoint`/`toLocal` with the event's transform and
   `withOverrides(tool.pen)` (override with candidate pen params for experiments).
2. Visual replay on `/pencil-test` (timed playback through the same drawing), and loading in Open….
3. Saving straight into the repo: e.g. a dev-only route writing to `tests/fixtures/pencil/` (iPad on
   the LAN against `next dev`), or document AirDrop/Files → copy. Keep it off in production.

**Stage 3 (test suite)**: vitest tests over fixture recordings (replay → strokes → `toInput`/outline
metrics: no lost segments, dots kept, hook/tail behaviour, no backtrack folds), golden outputs or
SVG snapshots (`strokeSvgPath`), and a short guide for assistants on adding a recording and iterating
on `pen-feel.ts`/`filters.ts`. Record real Pencil samples on device first.

## Checks run (stage 1)

`npx vitest run` (75 files pass, 1 skipped), `npm run typecheck`, `npx eslint`, `npx next build`
(`/pencil-test` static). In this worktree `node_modules` is an APFS clone of the main checkout's
(Turbopack rejects a symlinked one outside the root).
