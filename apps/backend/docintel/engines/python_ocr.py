"""PaddleOCR and docTR: local engines that live in Python rather than on PATH.

Neither is a dependency of WorkPilot. Both are heavy (PaddlePaddle, PyTorch or
TensorFlow underneath), both are better than Tesseract on some screenshots
(small UI text, dark themes, rotated labels), and both are a choice a person
makes by installing them and naming them in `DOCINTEL_OCR_ENGINE`. So they are
imported the first time an image is actually read, never at module import: a
status read must not load a deep-learning framework to learn it is absent.

Both keep the pixels on the machine. Both download their model weights the
first time they run, which is not the image leaving the machine — and under
an airgap the download fails, which is a recorded reason like any other.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import threading
from pathlib import Path
from typing import Any

from .base import OcrBox, OcrOutcome, lines_from_boxes, primary_lang

logger = logging.getLogger(__name__)

#: One model per (engine, language), built on first use: constructing either
#: is seconds of work, reading an image with a built one is not.
_MODELS: dict[tuple[str, str], Any] = {}
_LOCK = threading.Lock()


def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _box(points: Any, text: str, confidence: float, line: int) -> OcrBox | None:
    """A polygon (four points, or a flat list of eight numbers) -> a box."""
    try:
        flat = [
            float(v)
            for point in points
            for v in (point if hasattr(point, "__iter__") else [point])
        ]
    except (TypeError, ValueError):
        return None
    if len(flat) < 4:
        return None
    xs, ys = flat[0::2], flat[1::2]
    left, top = int(min(xs)), int(min(ys))
    return OcrBox(
        text=text,
        left=left,
        top=top,
        width=max(1, int(max(xs)) - left),
        height=max(1, int(max(ys)) - top),
        confidence=confidence,
        line=line,
    )


def parse_paddle(raw: Any) -> list[OcrBox]:
    """Both result shapes PaddleOCR has shipped, one box per recognised line.

    2.x returns ``[[ [polygon, (text, score)], … ]]`` per page; 3.x returns
    result objects (or dicts) carrying ``rec_texts``, ``rec_scores`` and
    ``rec_polys``. The engine's version is the user's, not ours to pin.
    """
    boxes: list[OcrBox] = []
    pages = raw if isinstance(raw, list) else [raw]
    for page in pages:
        if page is None:
            continue
        data = page if isinstance(page, dict) else getattr(page, "json", None)
        if isinstance(data, dict) and "res" in data:
            data = data["res"]
        if isinstance(data, dict) and "rec_texts" in data:
            texts = data.get("rec_texts") or []
            scores = data.get("rec_scores") or [-1.0] * len(texts)
            polys = data.get("rec_polys") or data.get("dt_polys") or [None] * len(texts)
            for text, score, poly in zip(texts, scores, polys):
                if not str(text).strip():
                    continue
                box = (
                    _box(poly, str(text), float(score) * 100, len(boxes))
                    if poly is not None
                    else None
                )
                boxes.append(
                    box or OcrBox(str(text), 0, 0, 0, 0, float(score) * 100, len(boxes))
                )
            continue
        for entry in page if isinstance(page, list) else []:
            try:
                poly, (text, score) = entry[0], entry[1]
            except (TypeError, ValueError, IndexError):
                continue
            if not str(text).strip():
                continue
            box = _box(poly, str(text), float(score) * 100, len(boxes))
            if box is not None:
                boxes.append(box)
    return boxes


def parse_doctr(export: dict) -> list[OcrBox]:
    """docTR's ``Document.export()`` -> word boxes in pixels.

    Geometry is relative (0-1) to the page, whose ``dimensions`` are
    ``(height, width)``; each docTR line becomes one text line.
    """
    boxes: list[OcrBox] = []
    line = 0
    for page in export.get("pages") or []:
        height, width = (page.get("dimensions") or (0, 0))[:2]
        for block in page.get("blocks") or []:
            for row in block.get("lines") or []:
                words = row.get("words") or []
                kept = False
                for word in words:
                    value = str(word.get("value") or "").strip()
                    if not value:
                        continue
                    try:
                        (x0, y0), (x1, y1) = word.get("geometry")[:2]
                    except (TypeError, ValueError):
                        continue
                    left, top = int(x0 * width), int(y0 * height)
                    boxes.append(
                        OcrBox(
                            text=value,
                            left=left,
                            top=top,
                            width=max(1, int(x1 * width) - left),
                            height=max(1, int(y1 * height) - top),
                            confidence=float(word.get("confidence", -0.01)) * 100,
                            line=line,
                        )
                    )
                    kept = True
                if kept:
                    line += 1
    return boxes


class _PythonEngine:
    local = True
    preview = True
    module = ""

    def available(self, env: dict[str, str]) -> str | None:
        return None if _installed(self.module) else "not-installed"

    def _model(self, lang: str) -> Any:
        key = (self.name, lang)  # type: ignore[attr-defined]
        with _LOCK:
            if key not in _MODELS:
                _MODELS[key] = self._build(lang)
            return _MODELS[key]

    def _build(self, lang: str) -> Any:  # pragma: no cover - needs the engine
        raise NotImplementedError

    def _read(self, model: Any, image: Path) -> list[OcrBox]:  # pragma: no cover
        raise NotImplementedError

    def recognize(self, image: Path, langs: str, env: dict[str, str]) -> OcrOutcome:
        name = self.name  # type: ignore[attr-defined]
        if not _installed(self.module):
            return OcrOutcome(reason="not-installed", engine=name)
        try:
            boxes = self._read(self._model(primary_lang(langs)), image)
        except Exception:  # noqa: BLE001 - a third-party stack, any failure
            logger.debug("docintel: %s failed on %s", name, image, exc_info=True)
            return OcrOutcome(reason="failed", engine=name)
        text = lines_from_boxes(boxes)
        if not text:
            return OcrOutcome(reason="empty", engine=name)
        return OcrOutcome(text=text, engine=name, boxes=tuple(boxes))


class PaddleOcrEngine(_PythonEngine):
    name = "paddleocr"
    module = "paddleocr"

    def _build(self, lang: str) -> Any:  # pragma: no cover - needs paddleocr
        paddleocr = importlib.import_module("paddleocr")
        return paddleocr.PaddleOCR(lang=lang)

    def _read(self, model: Any, image: Path) -> list[OcrBox]:  # pragma: no cover
        reader = getattr(model, "predict", None) or model.ocr
        return parse_paddle(reader(str(image)))


class DoctrEngine(_PythonEngine):
    name = "doctr"
    module = "doctr"

    def _build(self, lang: str) -> Any:  # pragma: no cover - needs doctr
        models = importlib.import_module("doctr.models")
        return models.ocr_predictor(pretrained=True)

    def _read(self, model: Any, image: Path) -> list[OcrBox]:  # pragma: no cover
        io = importlib.import_module("doctr.io")
        document = io.DocumentFile.from_images(str(image))
        return parse_doctr(model(document).export())
