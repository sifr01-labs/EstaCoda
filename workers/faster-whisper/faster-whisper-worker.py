#!/usr/bin/env python3
import json
import os
import sys
import traceback

PROTOCOL_VERSION = 1
SUPPORTED_PRESETS = {"tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3"}
MODEL_CACHE = {}


def respond(message_id, payload):
    payload["protocolVersion"] = PROTOCOL_VERSION
    payload["id"] = message_id
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def import_faster_whisper():
    from faster_whisper import WhisperModel  # type: ignore

    return WhisperModel


def handle_probe(message_id):
    try:
      import_faster_whisper()
      respond(message_id, {
          "ok": True,
          "content": "faster-whisper is importable.",
          "metadata": {"importable": True, "supportedPresets": sorted(SUPPORTED_PRESETS)},
      })
    except Exception as exc:
      respond(message_id, {
          "ok": False,
          "content": f"faster-whisper is not importable: {exc}",
          "metadata": {"importable": False, "errorType": type(exc).__name__},
      })


def handle_status(message_id):
    respond(message_id, {
        "ok": True,
        "content": "faster-whisper worker is running.",
        "metadata": {"modelCacheKeys": ["|".join(key) for key in MODEL_CACHE.keys()]},
    })


def handle_transcribe(message_id, request):
    model_name = request.get("model") or "base"
    if model_name not in SUPPORTED_PRESETS:
        respond(message_id, {
            "ok": False,
            "content": f"Unsupported faster-whisper model preset: {model_name}",
            "metadata": {"model": model_name},
        })
        return

    path = request.get("path")
    if not isinstance(path, str) or not path:
        respond(message_id, {
            "ok": False,
            "content": "faster-whisper transcription requires path.",
        })
        return

    device = request.get("device") or "auto"
    compute_type = request.get("computeType") or "default"
    language = request.get("language")
    allow_download = bool(request.get("allowDownload"))
    hf_home = request.get("hfHome")
    if isinstance(hf_home, str) and hf_home:
        os.environ["HF_HOME"] = hf_home
        os.environ.setdefault("TRANSFORMERS_CACHE", hf_home)

    try:
        WhisperModel = import_faster_whisper()
        key = (model_name, device, compute_type)
        if key not in MODEL_CACHE:
            MODEL_CACHE[key] = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                download_root=hf_home if isinstance(hf_home, str) and hf_home else None,
                local_files_only=not allow_download,
            )
        model = MODEL_CACHE[key]
        segments, info = model.transcribe(path, language=language)
        parts = []
        words = []
        for segment in segments:
            text = getattr(segment, "text", "")
            if text:
                parts.append(text.strip())
            for word in getattr(segment, "words", None) or []:
                words.append({
                    "word": getattr(word, "word", ""),
                    "start": getattr(word, "start", None),
                    "end": getattr(word, "end", None),
                })
        detected_language = getattr(info, "language", None) or language
        duration = getattr(info, "duration", None)
        respond(message_id, {
            "ok": True,
            "text": " ".join(part for part in parts if part),
            "model": model_name,
            "language": detected_language,
            "metadata": {
                "duration": duration,
                "words": words,
                "modelCacheSize": len(MODEL_CACHE),
            },
        })
    except Exception as exc:
        respond(message_id, {
            "ok": False,
            "content": f"faster-whisper transcription failed: {exc}",
            "metadata": {
                "errorType": type(exc).__name__,
                "trace": traceback.format_exc(limit=3),
            },
        })


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except Exception as exc:
            respond(None, {"ok": False, "content": f"Invalid JSON: {exc}"})
            continue

        message_id = request.get("id")
        if request.get("protocolVersion") != PROTOCOL_VERSION:
            respond(message_id, {
                "ok": False,
                "content": "Protocol mismatch.",
                "metadata": {"protocolVersion": request.get("protocolVersion")},
            })
            continue

        request_type = request.get("type")
        if request_type == "probe":
            handle_probe(message_id)
        elif request_type == "status":
            handle_status(message_id)
        elif request_type == "shutdown":
            respond(message_id, {"ok": True, "content": "shutdown"})
            return 0
        elif request_type == "transcribe":
            handle_transcribe(message_id, request)
        else:
            respond(message_id, {"ok": False, "content": f"Unknown request type: {request_type}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
