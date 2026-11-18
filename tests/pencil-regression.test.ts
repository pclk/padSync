import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecording } from "@/ink/recording";
import { baselineOf, compareBaselines, runReplay } from "@/ink/replay-harness";

// Pencil writing regression suite: every recording in tests/fixtures/pencil/ is replayed through
// the real controller and render pipeline, and its measurable result (stroke/point counts,
// processed-line metrics, fingerprints) is compared with the checked-in baseline next to it.
//
//   npm run test:pencil                         check every fixture against its baseline
//   PENCIL_UPDATE_BASELINES=1 npm run test:pencil  accept the current output as the new baselines
//   PENCIL_RECORDINGS=~/Downloads/rec.json npm run test:pencil   also replay these files (or a folder);
//                                                they need no baseline: their report is printed
//   PENCIL_REPORT_DIR=/tmp/pencil npm run test:pencil   write each full report (with SVG outlines) there
//
// A baseline diff after a writing change is the point: read it, decide whether the change is an
// improvement, then update the baselines in the same commit. See docs/pencil-test-handoff.md.

const fixtures = join(import.meta.dirname, "fixtures", "pencil");
const baselines = join(fixtures, "baselines");
const update = !!process.env.PENCIL_UPDATE_BASELINES;
const reportDir = process.env.PENCIL_REPORT_DIR;

const recordingFiles = (path: string): string[] =>
  statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".baseline.json"))
        .sort()
        .map((f) => join(path, f))
    : [path];

const checked = existsSync(fixtures) ? recordingFiles(fixtures) : [];
const extra = (process.env.PENCIL_RECORDINGS ?? "")
  .split(",")
  .filter(Boolean)
  .flatMap((p) => recordingFiles(resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"))));

const nameOf = (file: string) => basename(file).replace(/(\.pencil)?\.json$/, "");

function load(file: string) {
  const parsed = parseRecording(readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Error(`${file} is not a valid recording:\n${parsed.errors.join("\n")}`);
  return parsed.recording;
}

function writeReport(name: string, file: string) {
  if (!reportDir) return;
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, `${name}.report.json`), JSON.stringify(runReplay(load(file), { includeSvg: true }), null, 1));
}

describe("Pencil regression fixtures", () => {
  it("has fixtures to run", () => expect(checked.length).toBeGreaterThan(0));

  for (const file of checked) {
    const name = nameOf(file);
    it(`${name} replays to its baseline`, () => {
      const rec = load(file);
      const actual = baselineOf(runReplay(rec));
      // Replays must be repeatable before they can be compared.
      expect(baselineOf(runReplay(rec))).toEqual(actual);
      writeReport(name, file);
      const baselineFile = join(baselines, `${name}.baseline.json`);
      if (update || !existsSync(baselineFile)) {
        if (!update) throw new Error(`No baseline for ${name}. Run PENCIL_UPDATE_BASELINES=1 npm run test:pencil and commit ${baselineFile}.`);
        mkdirSync(baselines, { recursive: true });
        writeFileSync(baselineFile, JSON.stringify(actual, null, 1) + "\n");
        return;
      }
      const expected = JSON.parse(readFileSync(baselineFile, "utf8"));
      const diff = compareBaselines(expected, JSON.parse(JSON.stringify(actual)));
      if (diff.length) {
        throw new Error(
          `${name}: replay output changed (${diff.length}${diff.length >= 50 ? "+" : ""} differences). If intended, run PENCIL_UPDATE_BASELINES=1 npm run test:pencil.\n  ` +
            diff.join("\n  "),
        );
      }
    });
  }

  for (const file of extra) {
    const name = nameOf(file);
    it(`${name} (PENCIL_RECORDINGS) replays`, () => {
      const r = runReplay(load(file));
      writeReport(name, file);
      const summary = {
        file,
        source: r.recording.source,
        events: r.recording.events.total,
        samples: r.recording.samples,
        penIntervalMs: r.recording.penIntervalMs,
        strokes: r.totals.strokes,
        discarded: r.discarded.count,
        points: r.totals.points,
        processedPoints: r.totals.processedPoints,
        fingerprint: r.fingerprint,
        outlineFingerprint: r.outlineFingerprint,
        matchesCapture: r.capture?.matches ?? null,
        captureDifferences: r.capture?.differences.slice(0, 5) ?? [],
        replayMs: r.performance.replayMs,
      };
      console.log(JSON.stringify(summary, null, 1));
      expect(r.recording.events.total).toBeGreaterThan(0);
    });
  }
});
