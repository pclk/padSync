import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecording, serializeRecording } from "@/ink/recording";
import { FIXTURES } from "./helpers/pencil-fixtures";

// Keeps the checked-in SYNTHETIC recordings in step with their specs (tests/helpers/pencil-fixtures.ts).
// PENCIL_WRITE_FIXTURES=1 rewrites them. Only the input events are compared: `committed` is what
// the controller made at generation time and is allowed to differ after a pipeline change (the
// regression baselines track that).

const dir = join(import.meta.dirname, "fixtures", "pencil");

describe("synthetic Pencil fixtures", () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`${name} matches its spec`, () => {
      const rec = make();
      const file = join(dir, `${name}.pencil.json`);
      if (process.env.PENCIL_WRITE_FIXTURES) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify(rec, null, 1) + "\n");
      }
      const parsed = parseRecording(readFileSync(file, "utf8"));
      if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
      expect(parsed.recording.source).toBe("synthetic");
      expect(parsed.recording.label.startsWith("SYNTHETIC")).toBe(true);
      expect(JSON.parse(serializeRecording(parsed.recording)).events, "regenerate with PENCIL_WRITE_FIXTURES=1 npm run test:pencil").toEqual(JSON.parse(serializeRecording(rec)).events);
    });
  }
});
