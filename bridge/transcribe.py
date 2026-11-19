# Speech-to-text worker for the padSync bridge (bridge/speech.ts starts it with `uv run`).
# Keeps NVIDIA Parakeet TDT loaded on the GPU via MLX, so a voice message takes ~0.1 s once warm.
# Protocol: one JSON object per line. In: {"id": "...", "path": "/abs/audio"}.
# Out: {"ready": true} once warmed up, then {"id": "...", "text": "..."} or {"id": "...", "error": "..."}.
import json
import os
import struct
import sys
import tempfile
import time
import wave

MODEL = os.environ.get("PADSYNC_SPEECH_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def warm_up(model):
    # The first transcription compiles the Metal kernels (~2 s); do it before any real message.
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(struct.pack("<16000h", *([0] * 16000)))
        model.transcribe(path)
    finally:
        os.unlink(path)


def main():
    from parakeet_mlx import from_pretrained

    started = time.time()
    model = from_pretrained(MODEL)
    warm_up(model)
    say({"ready": True, "model": MODEL, "seconds": round(time.time() - started, 2)})
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            # Long recordings go in 2-minute windows so memory stays flat.
            result = model.transcribe(req["path"], chunk_duration=120, overlap_duration=15)
            say({"id": req.get("id"), "text": result.text.strip()})
        except Exception as e:  # noqa: BLE001 - every failure goes back to the bridge
            say({"id": req.get("id"), "error": str(e)[:500]})


if __name__ == "__main__":
    main()
