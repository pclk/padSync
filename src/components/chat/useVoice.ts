"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Hold-to-talk: records compressed audio here and sends it with the turn; the Mac bridge
// transcribes it (NVIDIA Parakeet, bridge/speech.ts) and runs the agent on the words.

/** The hold-to-talk hotkey: ⌥M (Alt+M). `code` so the Option layer (µ) does not matter. */
export const isTalkKey = (e: { code: string; altKey: boolean; metaKey?: boolean; ctrlKey?: boolean }) =>
  e.code === "KeyM" && e.altKey && !e.metaKey && !e.ctrlKey;

/** Holds shorter than this are taps: nothing is sent. */
export const MIN_HOLD_MS = 350;
/** Longer recordings are sent at this point, as if released. */
export const MAX_RECORDING_MS = 10 * 60_000;

/** Opus where the browser has it (Chrome, Firefox, newer Safari), else AAC (older Safari). */
const FORMATS = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

/** The file a recording travels as: `voice-message.<ext>` (src/lib/context.ts VOICE_PATH_RE). */
export function voiceFile(type: string): { path: string; mime: string } {
  const mime = type.split(";")[0].trim().toLowerCase();
  if (mime === "audio/mp4" || mime === "audio/aac" || mime === "audio/x-m4a") return { path: "voice-message.m4a", mime: "audio/mp4" };
  if (mime === "audio/ogg") return { path: "voice-message.ogg", mime: "audio/ogg" };
  if (mime === "audio/wav" || mime === "audio/x-wav") return { path: "voice-message.wav", mime: "audio/wav" };
  return { path: "voice-message.webm", mime: "audio/webm" };
}

const canRecord = () =>
  typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export type VoiceState = "idle" | "starting" | "recording";

export function useVoice(p: {
  /** `releasedAt`: when the key or button was let go, the start of the message's latency trace. */
  onAudio(audio: Blob, took: { releasedAt: number; durationMs: number }): void;
  onError(message: string): void;
}) {
  const supported = useSyncExternalStore(
    () => () => {},
    canRecord,
    () => false,
  );
  const [state, setState] = useState<VoiceState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  /** Waiting for the browser to grant the microphone. */
  const opening = useRef(false);
  const releasedAt = useRef(0);
  /** Set by a release or cancel; read when recording stops (or the mic is granted late). */
  const outcome = useRef<"send" | "cancel" | null>(null);
  const callbacks = useRef(p);
  useEffect(() => {
    callbacks.current = p;
  });
  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(
    () => () => {
      outcome.current = "cancel";
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    },
    [],
  );
  useEffect(() => {
    if (state !== "recording") return;
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(Math.floor(ms / 1000));
      if (ms >= MAX_RECORDING_MS) finish();
    }, 250);
    return () => clearInterval(timer);
  });

  async function start() {
    if (opening.current || recorder.current || stream.current) return;
    outcome.current = null;
    opening.current = true;
    setElapsed(0);
    setState("starting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      setState("idle");
      const name = (error as Error).name;
      callbacks.current.onError(
        name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it for this site in the browser's settings."
          : name === "NotFoundError"
            ? "No microphone was found."
            : `Could not start recording: ${(error as Error).message}`,
      );
      return;
    } finally {
      opening.current = false;
    }
    stream.current = media;
    // Released (or cancelled) while the browser was asking for the microphone.
    if (outcome.current) {
      release();
      setState("idle");
      if (outcome.current === "send") callbacks.current.onError("Microphone ready. Hold ⌥M or the mic while you speak.");
      return;
    }
    const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
    const r = new MediaRecorder(media, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    r.onstop = () => {
      recorder.current = null;
      release();
      setState("idle");
      if (outcome.current !== "send") return;
      const audio = new Blob(chunks, { type: r.mimeType || mimeType || "audio/webm" });
      if (audio.size) callbacks.current.onAudio(audio, { releasedAt: releasedAt.current, durationMs: releasedAt.current - startedAt.current });
      else callbacks.current.onError("Nothing was recorded. Check the microphone and try again.");
    };
    recorder.current = r;
    r.start();
    startedAt.current = Date.now();
    setState("recording");
  }

  /** Release: send the recording (unless it was only a tap). */
  function finish() {
    const r = recorder.current;
    if (!r) {
      // Still waiting for the microphone: start() sees this and stops.
      if (opening.current) outcome.current ??= "send";
      return;
    }
    if (r.state !== "recording" || outcome.current) return;
    if (Date.now() - startedAt.current < MIN_HOLD_MS) {
      callbacks.current.onError("Hold to talk: keep ⌥M or the mic held while you speak.");
      return cancel();
    }
    outcome.current = "send";
    releasedAt.current = Date.now();
    r.stop();
  }

  function cancel() {
    outcome.current = "cancel";
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  // Not state: a key can be released before the render that follows start().
  const active = () => opening.current || !!recorder.current;
  return { supported, state, elapsed, start, finish, cancel, active };
}
