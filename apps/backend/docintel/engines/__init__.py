"""Interchangeable OCR engines, tried in the order the project names them.

`DOCINTEL_OCR_ENGINE` is an ordered fallback list — ``tesseract`` by default,
``paddleocr,tesseract`` or ``ollama-vision,tesseract`` when a person installed
something better. The first engine that produces text answers, and the record
says which one did; every engine skipped on the way leaves an ``engine:reason``
behind it, so "why did the vision model not answer" is on the record rather
than in a debug log.

Two refusals happen here rather than in each engine, because an engine must not
be the one deciding whether it may run:

- **the airgap** — an engine that is not local is refused under
  `airgapStrict` before it is asked anything, and with no project to read the
  policy from it is refused too: a cloud call is opt-in, never a default of an
  unreadable file;
- **the preview** — the Kanban panel recomputes on every opening, and an engine
  that is slow or metered (``preview = False``) is deferred to the build.

Nothing here raises. An engine that does is a ``failed`` attempt.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path

from .. import settings
from .azure_di import AzureDocumentIntelligenceEngine
from .base import OcrBox, OcrEngine, OcrOutcome
from .ollama_vision import OllamaVisionEngine
from .python_ocr import DoctrEngine, PaddleOcrEngine
from .tesseract import TesseractEngine, tesseract_path

logger = logging.getLogger(__name__)

ENGINES: dict[str, OcrEngine] = {
    engine.name: engine
    for engine in (
        TesseractEngine(),
        PaddleOcrEngine(),
        DoctrEngine(),
        OllamaVisionEngine(),
        AzureDocumentIntelligenceEngine(),
    )
}


def cloud_refusal(policy_paths: tuple[Path, ...]) -> tuple[str, str] | None:
    """(reason, message) when a cloud engine may not run for these paths.

    An unreadable policy is treated as strict: the airgap is the one setting
    whose failure mode must be "nothing left the machine".
    """
    if not policy_paths:
        return (
            "no-project",
            "docintel: a cloud OCR engine was skipped because no project was "
            "given to read the offline policy from.",
        )
    try:
        from core.offline_policy import STRICT_EXIT_HINT, airgap_status

        status = airgap_status(*policy_paths)
    except Exception:  # noqa: BLE001 - unreadable policy: fail closed
        return (
            "airgap",
            "docintel: a cloud OCR engine was skipped because the project's "
            "offline policy could not be read.",
        )
    if not status.get("airgapStrict"):
        return None
    return (
        "airgap",
        f"docintel: {settings.OCR_ENGINE_ENV} lists a cloud OCR engine, and this "
        f"project is under airgapStrict ({status.get('policyPath')}). The image "
        f"was not sent. Remove it from {settings.OCR_ENGINE_ENV}, or: "
        f"{STRICT_EXIT_HINT}",
    )


def recognize(
    image: Path,
    env: dict[str, str],
    *,
    policy_paths: tuple[Path, ...] = (),
    preview: bool = False,
) -> OcrOutcome:
    """Text in `image` from the first engine that has some. Never raises."""
    if not settings.local_ocr_enabled(env):
        return OcrOutcome(reason="disabled")

    langs = settings.ocr_langs(env)
    attempts: list[str] = []
    ran: OcrOutcome | None = None
    first: OcrOutcome | None = None
    for name in settings.ocr_engines(env):
        engine = ENGINES.get(name)
        if engine is None:
            reason = "unknown-engine"
        elif preview and not engine.preview:
            reason = "deferred"
        elif not engine.local and (refusal := cloud_refusal(policy_paths)):
            reason, message = refusal
            logger.warning(message)
        else:
            reason = engine.available(env)
        if reason:
            attempts.append(f"{name}:{reason}")
            first = first or OcrOutcome(reason=reason, engine=name)
            continue

        try:
            outcome = engine.recognize(image, langs, env)
        except Exception:  # noqa: BLE001 - an engine, not the build
            logger.debug("docintel: engine %s raised", name, exc_info=True)
            outcome = OcrOutcome(reason="failed", engine=name)
        if outcome.text:
            return replace(outcome, engine=name, attempts=tuple(attempts))
        attempts.append(f"{name}:{outcome.reason or 'empty'}")
        ran = replace(outcome, engine=name, reason=outcome.reason or "empty")

    chosen = ran or first or OcrOutcome(reason="no-engine")
    return replace(chosen, attempts=tuple(attempts))


__all__ = [
    "ENGINES",
    "OcrBox",
    "OcrEngine",
    "OcrOutcome",
    "cloud_refusal",
    "recognize",
    "tesseract_path",
]
