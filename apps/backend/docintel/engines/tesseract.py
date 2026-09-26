"""Tesseract, the default engine: local, a binary rather than a Python stack.

Asked for TSV rather than plain text, because the TSV carries a box per word —
and a box is what lets a secret found in the text be painted over on the
image. A Tesseract that answers in plain text anyway (an old build, a wrapper
script) is still read: the words are kept, only the boxes are lost, and a
secret found in them then withholds the image rather than masking it.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .. import settings
from .base import OcrBox, OcrOutcome, lines_from_boxes

_TIMEOUT_SECONDS = 60
_TSV_HEADER = "level\tpage_num"


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
    command.append("tsv")
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_TIMEOUT_SECONDS,
        check=False,
    )


def parse_tsv(output: str) -> tuple[str, list[OcrBox]]:
    """Tesseract's TSV -> (text, word boxes). Lines keep Tesseract's grouping.

    A word is level 5; its line is the (block, paragraph, line) triple, which
    is renumbered from 0 in reading order so `OcrBox.line` indexes the text.
    """
    boxes: list[OcrBox] = []
    line_index: dict[tuple[str, str, str], int] = {}
    for row in output.splitlines()[1:]:
        cells = row.split("\t")
        if len(cells) < 12 or cells[0] != "5":
            continue
        word = cells[11].strip()
        if not word:
            continue
        key = (cells[2], cells[3], cells[4])
        index = line_index.setdefault(key, len(line_index))
        try:
            left, top, width, height = (int(c) for c in cells[6:10])
            confidence = float(cells[10])
        except ValueError:
            continue
        boxes.append(OcrBox(word, left, top, width, height, confidence, index))
    return lines_from_boxes(boxes), boxes


class TesseractEngine:
    name = "tesseract"
    local = True
    preview = True

    def available(self, env: dict[str, str]) -> str | None:
        return None if tesseract_path(env) else "no-engine"

    def recognize(self, image: Path, langs: str, env: dict[str, str]) -> OcrOutcome:
        binary = tesseract_path(env)
        if not binary:
            return OcrOutcome(reason="no-engine", engine=self.name)
        try:
            completed = _run(binary, image, langs)
            # A language pack that is not installed is an error, not an empty
            # page: retry with Tesseract's own default rather than report
            # nothing.
            if completed.returncode != 0 and langs:
                completed = _run(binary, image, None)
        except subprocess.TimeoutExpired:
            return OcrOutcome(reason="timeout", engine=self.name)
        except OSError:
            return OcrOutcome(reason="failed", engine=self.name)

        if completed.returncode != 0:
            return OcrOutcome(reason="failed", engine=self.name)
        output = completed.stdout
        if output.lstrip().startswith(_TSV_HEADER):
            text, boxes = parse_tsv(output)
        else:
            text = "\n".join(line.rstrip() for line in output.splitlines()).strip()
            boxes = []
        if not text:
            return OcrOutcome(reason="empty", engine=self.name)
        return OcrOutcome(text=text, engine=self.name, boxes=tuple(boxes))
