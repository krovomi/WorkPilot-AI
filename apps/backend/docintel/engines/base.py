"""What an OCR engine is, and what it returns.

No engine is imported here, and nothing here imports one: the preflight, the
redaction and the tests all read these shapes, and a status read must not pay
for a PaddlePaddle import to learn that the machine has no PaddlePaddle.
"""

from __future__ import annotations

import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class OcrBox:
    """One recognised word (or line, for engines that stop there), in pixels.

    The boxes are what make a redaction possible: a secret found in the text
    can only be painted over on the image if the text knows where it was.
    """

    text: str
    left: int
    top: int
    width: int
    height: int
    #: 0-100, or -1 when the engine does not say.
    confidence: float = -1.0
    #: Index of the line in `OcrOutcome.text` this box belongs to.
    line: int = 0


@dataclass(frozen=True)
class OcrOutcome:
    text: str = ""
    #: Why there is no text: ``disabled``, ``no-engine``, ``timeout``,
    #: ``failed``, ``empty``, ``airgap``, ``not-configured``,
    #: ``not-installed``, ``deferred``. Empty when text was produced.
    reason: str = ""
    #: Which engine answered — or, with no text, the last one asked.
    engine: str = ""
    boxes: tuple[OcrBox, ...] = ()
    #: True when a vision model *described* the image (layout, what is shown)
    #: rather than only transcribing it. The prompt says which it is: a
    #: description is a model's reading, a transcription is the pixels' words.
    described: bool = False
    #: ``engine:reason`` for every engine tried before the one that answered,
    #: so "why did Tesseract not answer" survives the fallback.
    attempts: tuple[str, ...] = field(default_factory=tuple)


@runtime_checkable
class OcrEngine(Protocol):
    #: The name `DOCINTEL_OCR_ENGINE` lists and the record carries.
    name: str
    #: False for an engine that sends the image off the machine. The chain
    #: refuses such an engine under `airgapStrict`, before asking it anything.
    local: bool
    #: False for an engine too slow or too costly to run on every opening of
    #: the Kanban panel (a vision model, a metered cloud call): the preview
    #: says it is deferred to the build instead of paying for it.
    preview: bool

    def available(self, env: dict[str, str]) -> str | None:
        """None when the engine can run here, else the reason it cannot."""

    def recognize(self, image: Path, langs: str, env: dict[str, str]) -> OcrOutcome:
        """Text in `image`. Never raises: a failure is an outcome's reason."""


def lines_from_boxes(boxes: list[OcrBox]) -> str:
    """The text a list of boxes spells, one line per `OcrBox.line`."""
    lines: dict[int, list[str]] = {}
    for box in boxes:
        lines.setdefault(box.line, []).append(box.text)
    return "\n".join(" ".join(words) for _, words in sorted(lines.items())).strip()


def primary_lang(langs: str) -> str:
    """`eng+fra` -> `en`: the first language, in the two-letter spelling the
    Python engines use. Unknown codes fall back to English."""
    first = (langs or "eng").split("+")[0].strip().lower()
    return {
        "eng": "en",
        "fra": "fr",
        "deu": "german",
        "spa": "es",
        "ita": "it",
        "por": "pt",
        "nld": "nl",
    }.get(first, "en")


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an error, never a new destination.

    urllib copies the request headers onto the redirected request, so a
    server answering 302 to another host would receive whatever credential
    the first request carried — and the image, for a 307. The engines talk
    to one host they were configured for, and nowhere else.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_opener(*, proxy: bool = True) -> urllib.request.OpenerDirector:
    """An opener that never follows a redirect; without the proxy on request."""
    handlers: list = [_RefuseRedirect()]
    if not proxy:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)
