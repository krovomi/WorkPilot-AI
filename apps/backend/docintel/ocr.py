"""OCR, on the machine: the compatible entry point over `docintel.engines`.

Local by default, on purpose. The agents that read the task can already open
an image with their own file tool, through the provider the user chose — so a
second, cloud OCR call made here would be a way for a screenshot to reach a
service the task was not configured for, and in `airgapStrict` mode a way
around the barrier. The default chain is Tesseract alone; PaddleOCR, docTR and
a local vision model through Ollama are engines a person installs and names in
`DOCINTEL_OCR_ENGINE`. The one cloud engine (Azure Document Intelligence) is
opt-in twice over and refused under an airgap — see `engines/__init__.py`.

What it buys is a screenshot turned into text *before* planning, where it can
be searched, quoted, and scanned for secrets and injected instructions, instead
of pixels every phase has to look at again.
"""

from __future__ import annotations

from pathlib import Path

from .engines import recognize, tesseract_path
from .engines.base import OcrBox, OcrOutcome

__all__ = ["OcrBox", "OcrOutcome", "ocr_image", "tesseract_path"]


def ocr_image(
    image: Path,
    env: dict[str, str],
    *,
    policy_paths: tuple[Path, ...] = (),
    preview: bool = False,
) -> OcrOutcome:
    """Text in `image`, or the reason there is none. Never raises.

    `policy_paths` are the directories whose offline policy governs this read
    (the spec and the project): without them a cloud engine is never asked.
    `preview` is the Kanban's read, which defers slow or metered engines.
    """
    return recognize(image, env, policy_paths=policy_paths, preview=preview)
