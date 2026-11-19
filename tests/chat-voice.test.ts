import { describe, expect, it } from "vitest";
import { isTalkKey, voiceFile } from "@/components/chat/useVoice";
import { VOICE_PATH_RE } from "@/lib/context";
import { parseWorkerLine } from "../bridge/speech";
import { VOICE_PATH_RE as BRIDGE_VOICE_PATH_RE } from "../bridge/lib";

describe("hold to talk", () => {
  it("matches ⌥M by key position, whatever the Option layer types", () => {
    expect(isTalkKey({ code: "KeyM", altKey: true })).toBe(true);
    expect(isTalkKey({ code: "KeyM", altKey: false })).toBe(false);
    expect(isTalkKey({ code: "KeyM", altKey: true, metaKey: true })).toBe(false);
    expect(isTalkKey({ code: "KeyN", altKey: true })).toBe(false);
  });

  it("names recordings so the server and the bridge both know them", () => {
    for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav", ""]) {
      const f = voiceFile(type);
      expect(VOICE_PATH_RE.test(f.path)).toBe(true);
      expect(BRIDGE_VOICE_PATH_RE.test(f.path)).toBe(true);
    }
    expect(voiceFile("audio/mp4")).toEqual({ path: "voice-message.m4a", mime: "audio/mp4" });
    expect(voiceFile("audio/webm;codecs=opus")).toEqual({ path: "voice-message.webm", mime: "audio/webm" });
    expect(VOICE_PATH_RE.test("notes/voice-message.webm")).toBe(false);
  });

  it("reads the speech worker's replies and skips other output", () => {
    expect(parseWorkerLine('{"ready": true, "seconds": 3.1}')).toEqual({ ready: true, seconds: 3.1 });
    expect(parseWorkerLine('{"id": "1", "text": "hello"}')).toEqual({ id: "1", text: "hello" });
    expect(parseWorkerLine('{"id": "2", "error": "bad audio"}')).toEqual({ id: "2", error: "bad audio" });
    expect(parseWorkerLine("Fetching 5 files: 100%")).toBeNull();
    expect(parseWorkerLine('{"id": 3}')).toBeNull();
  });
});
