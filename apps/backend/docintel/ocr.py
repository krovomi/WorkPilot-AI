"""Local OCR, when the machine has Tesseract, and nothing when it does not.

Local only, on purpose. The agents that read the task can already open an
image with their own file tool, through the provider the user chose — so a
second, cloud OCR call made here would be a way for a screenshot to reach a
service the task was not configured for, and in `airgapStrict` mode a way
around the barrier. Tesseract runs on the machine and sends nothing anywhere.

What it buys is a screenshot turned into text *before* planning, where it can
be searched, quoted and scanned for injected instructions, instead of pixels
every phase has to look at again.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import settings

_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class OcrOutcome:
    text: str = ""
    #: Why there is no text: ``disabled``, ``no-engine``, ``timeout``,
    #: ``failed``, ``empty``. Empty when text was produced.
    reason: str = ""


def tesseract_path(env: dict[str, str]) -> str | None:
    explicit = str(env.get(settings.TESSERACT_PATH_ENV) or "").strip()
    if explicit:
        return explicit if Path(explicit).is_file() else None
    try:
        from core.platform import find_executable

        return find_executable("tesseract")
    except Exception:  # noqa: BLE001 - the platform layer is optional in tests
        return shutil.which("tesseract")


def _run(binary: str, image: Path, langs: str | None) -> subprocess.CompletedProcess:
    command = [binary, str(image), "stdout"]
    if langs:
        command += ["-l", langs]
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_TIMEOUT_SECONDS,
        check=False,
    )


def ocr_image(image: Path, env: dict[str, str]) -> OcrOutcome:
    """Text in `image`, or the reason there is none. Never raises."""
    if not settings.local_ocr_enabled(env):
        return OcrOutcome(reason="disabled")
    binary = tesseract_path(env)
    if not binary:
        return OcrOutcome(reason="no-engine")

    langs = settings.ocr_langs(env)
    try:
        completed = _run(binary, image, langs)
        # A language pack that is not installed is an error, not an empty page:
        # retry with Tesseract's own default rather than report nothing.
        if completed.returncode != 0 and langs:
            completed = _run(binary, image, None)
    except subprocess.TimeoutExpired:
        return OcrOutcome(reason="timeout")
    except OSError:
        return OcrOutcome(reason="failed")

    if completed.returncode != 0:
        return OcrOutcome(reason="failed")
    text = "\n".join(line.rstrip() for line in completed.stdout.splitlines()).strip()
    return OcrOutcome(text=text) if text else OcrOutcome(reason="empty")
