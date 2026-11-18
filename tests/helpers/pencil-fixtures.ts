import type { PencilRecording } from "@/ink/recording";
import { letterPaths, synthesize } from "./synthetic-pencil";

// The SYNTHETIC recordings checked in under tests/fixtures/pencil/. Each is generated from the spec
// here (tests/pencil-fixtures.test.ts keeps the files in step); none came from a device. Real
// iPad recordings go next to them as files only — see docs/pencil-test-handoff.md.

const word = (text: string, x: number, y: number, ms = 200) => letterPaths(text, x, y).map((path) => ({ path, durationMs: path.length === 1 ? 70 : ms }));

export const FIXTURES: Record<string, () => PencilRecording> = {
  // Plain handwriting-like strokes at zoom 1: multiple strokes, a dot (the i), coalesced and
  // predicted samples on every move.
  "synthetic-words": () => synthesize({ label: "words: hi lo", strokes: [...word("hi", 120, 100), ...word("lo", 200, 100, 260)] }),
  // The same kind of writing on a zoomed-out, scrolled page across two sections: section
  // coordinates must come out as if written at zoom 1.
  "synthetic-zoomed-two-sections": () =>
    synthesize({
      label: "zoomed 0.75, two sections",
      zoom: 0.75,
      rect: { left: 212.5, top: -340.25 },
      strokes: [...word("at", 300, 200).map((s) => ({ ...s, section: "sec-a" })), ...word("hit", 80, 60).map((s) => ({ ...s, section: "sec-b" }))],
    }),
  // What goes wrong on real iPads: a cancelled stroke (Scribble/system gesture), lost capture with a
  // late pointerup, a finger on the page (palm), a light bounce the stray-dot filter removes, slow
  // writing with tilt changes, a mouse stroke, and a stroke still open when recording stopped.
  "synthetic-edge-cases": () =>
    synthesize({
      label: "edge cases",
      strokes: [
        { path: [[100, 300], [180, 320]], durationMs: 150, end: "cancel" },
        { path: [[100, 360], [140, 400], [180, 360]], durationMs: 200, end: "lost" },
        { path: [[400, 300], [460, 340]], durationMs: 120, pointerType: "touch", pointerId: 11, gapMs: 0 },
        { path: [[250, 250]], durationMs: 12, pressure: () => 0.04 },
        { path: [[100, 450], [300, 452]], durationMs: 900, altitude: (u) => 0.5 + 0.9 * u, azimuth: (u) => 1 + 3 * u, pressure: (u) => 0.1 + 0.6 * u },
        { path: [[100, 520], [160, 560]], durationMs: 150, pointerType: "mouse", pointerId: 1, gapMs: 0 },
        { path: [[100, 600], [200, 640]], durationMs: 160, end: "open" },
      ],
    }),
};
