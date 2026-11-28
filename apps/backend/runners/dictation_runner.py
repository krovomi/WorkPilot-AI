"""Local multilingual dictation. JSON lines over stdin/stdout; never logs audio.

The model is downloaded only by the explicit --download action. Normal sessions
set local_files_only=True and keep a single model loaded until stdin closes.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from pathlib import Path

LANGUAGES = {
    "auto",
    "fr",
    "en",
    "es",
    "de",
    "it",
    "pt",
    "nl",
    "pl",
    "ja",
    "zh",
    "ar",
    "uk",
}


# Below this, Whisper's guess of the spoken language is not reported.
DETECTION_CONFIDENCE = 0.5


def transcribe_audio(model, audio: bytes, language: str) -> str:
    return transcribe_with_language(model, audio, language)[0]


def transcribe_with_language(
    model, audio: bytes, language: str
) -> tuple[str, str | None]:
    """The text, and the language Whisper heard when it was asked to detect it.

    The detected language is reported only from the closed list above and
    when Whisper is confident enough, so the app can read the sentence (and
    ask its model) in the language actually spoken.
    """
    language = language.split("-")[0]
    if language not in LANGUAGES:
        raise ValueError("language")
    segments, info = model.transcribe(
        io.BytesIO(audio),
        language=None if language == "auto" else language,
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments if s.text.strip())
    return text, _detected(info) if language == "auto" and text else None


def _detected(info) -> str | None:
    heard = getattr(info, "language", None)
    confidence = getattr(info, "language_probability", 0)
    if heard == "auto" or heard not in LANGUAGES:
        return None
    if not isinstance(confidence, (int, float)) or confidence < DETECTION_CONFIDENCE:
        return None
    return heard


def emit(**result):
    print(json.dumps(result, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--project")
    args = parser.parse_args()
    try:
        from faster_whisper import WhisperModel
    except (ImportError, OSError):
        emit(error="dependency")
        return
    if args.download:
        # Enforce the project's effective airgap policy in the backend too.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from offline_policy import airgap_status

        if not args.project or airgap_status(Path(args.project))["airgapStrict"]:
            emit(error="offline")
            return
    try:
        model = WhisperModel(
            "base",
            device="cpu",
            compute_type="int8",
            download_root=args.cache,
            local_files_only=not args.download,
        )
    except Exception:
        emit(error="download" if args.download else "model")
        return
    emit(ready=True)
    if args.download:
        return
    for line in sys.stdin:
        try:
            request = json.loads(line)
            audio = base64.b64decode(request["audio"], validate=True)
            if len(audio) > 8_000_000:
                raise ValueError("audio too large")
            text, spoken = transcribe_with_language(model, audio, request["language"])
            emit(text=text, **({"language": spoken} if spoken else {}))
        except Exception:
            emit(error="transcription")


if __name__ == "__main__":
    # Launched without PYTHONPATH: put the backend on the path for core.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
