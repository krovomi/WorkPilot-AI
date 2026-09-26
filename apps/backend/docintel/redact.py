"""Secrets in what the preflight read: named, masked, never repeated.

A screenshot is where a secret leaks without anybody deciding to leak it: the
Azure portal with the storage key on screen, an `appsettings.json` open in the
IDE behind a stack trace, a Postman request with its bearer token. Once it is
text it can be matched; before it is text it is pixels an agent will upload to
whichever provider the task runs on.

The patterns are `security/scan_secrets.py`'s — the same table the pre-commit
scan uses, and the only one. A second list here would drift from it the first
time somebody added a provider there.

Three things follow from a match, and none of them depends on which provider
the task was configured for — a phase can run on another provider than the one
before it, and the preflight runs before any of them:

- the **text** is masked in place (``[REDACTED: <kind>]``) before it reaches
  the record, the extracted file or a prompt;
- the **image** is repainted — a copy with every OCR line that carried a secret
  covered, written under ``docintel/redacted/`` — when the engine gave boxes
  and Pillow is installed; otherwise it is **withheld**;
- the record names the *kind* of secret, never its value, not even a prefix.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .engines.base import OcrBox

logger = logging.getLogger(__name__)

REDACTED_DIR = "redacted"
#: Pixels of margin around a masked line: OCR boxes are tight, anti-aliased
#: glyph edges are not.
_PADDING = 3


@dataclass(frozen=True)
class SecretFinding:
    kind: str
    #: 0-based line of the text, and the character span within that line.
    line: int
    start: int
    end: int


class ScannerUnavailable(RuntimeError):
    """The secret table could not be loaded. Callers fail closed on it."""


def _scan_content():
    try:
        from security.scan_secrets import scan_content
    except Exception as exc:  # noqa: BLE001 - reported as unavailable
        raise ScannerUnavailable(str(exc)) from exc
    return scan_content


def find_secrets(text: str) -> list[SecretFinding]:
    """Every secret-shaped span in `text`, by line. Raises ScannerUnavailable."""
    if not text:
        return []
    scan_content = _scan_content()
    lines = text.splitlines()
    findings: list[SecretFinding] = []
    for match in scan_content(text, "docintel"):
        index = match.line_number - 1
        if not 0 <= index < len(lines):
            continue
        start = lines[index].find(match.matched_text)
        if start < 0:
            continue
        findings.append(
            SecretFinding(
                match.pattern_name, index, start, start + len(match.matched_text)
            )
        )
    return findings


def kinds(findings: list[SecretFinding]) -> list[str]:
    return sorted({f.kind for f in findings})


def mask_text(text: str, findings: list[SecretFinding]) -> str:
    """`text` with every finding replaced by its kind. Overlaps merge."""
    if not findings:
        return text
    lines = text.splitlines()
    by_line: dict[int, list[SecretFinding]] = {}
    for finding in findings:
        by_line.setdefault(finding.line, []).append(finding)
    for index, spans in by_line.items():
        line = lines[index]
        merged: list[list] = []
        for finding in sorted(spans, key=lambda f: f.start):
            if merged and finding.start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], finding.end)
            else:
                merged.append([finding.start, finding.end, finding.kind])
        for start, end, kind in reversed(merged):
            line = f"{line[:start]}[REDACTED: {kind}]{line[end:]}"
        lines[index] = line
    return "\n".join(lines)


def redact_text(text: str) -> tuple[str, list[str]]:
    """(masked text, kinds). Raises ScannerUnavailable."""
    findings = find_secrets(text)
    return mask_text(text, findings), kinds(findings)


def pillow_available() -> bool:
    try:
        import PIL.Image  # noqa: F401
    except Exception:  # noqa: BLE001 - absent or broken, same answer
        return False
    return True


def covering_boxes(
    boxes: tuple[OcrBox, ...] | list[OcrBox], findings: list[SecretFinding]
) -> list[OcrBox] | None:
    """The boxes to paint over, or None when a finding has no box to cover.

    Whole lines, not only the words the pattern matched: OCR splits and merges
    tokens (`AccountKey=abc` may be one box or three), and a line boundary is
    the one unit every engine agrees on. Covering `Server=db;` beside the
    password costs context; missing one character of the key costs the key.
    """
    lines = {f.line for f in findings}
    chosen = [b for b in boxes if b.line in lines and b.width > 0 and b.height > 0]
    if {b.line for b in chosen} != lines:
        return None
    return chosen


def write_redacted_image(image: Path, boxes: list[OcrBox], target: Path) -> bool:
    """A copy of `image` with `boxes` painted black, as PNG. Never raises.

    The copy is re-encoded from pixels, so nothing of the original's metadata
    (PNG text chunks, EXIF) survives into it — a chunk can carry the secret
    too.
    """
    try:
        from PIL import Image, ImageDraw

        with Image.open(image) as source:
            source.load()
            picture = source.convert("RGB")
        draw = ImageDraw.Draw(picture)
        width, height = picture.size
        for box in boxes:
            draw.rectangle(
                (
                    max(0, box.left - _PADDING),
                    max(0, box.top - _PADDING),
                    min(width, box.left + box.width + _PADDING),
                    min(height, box.top + box.height + _PADDING),
                ),
                fill=(0, 0, 0),
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        picture.save(target, format="PNG")
    except Exception:  # noqa: BLE001 - no copy means the image is withheld
        logger.debug("docintel: could not write a redacted copy", exc_info=True)
        return False
    return True
