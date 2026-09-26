"""Switches, read from the environment and from `.workpilot/.env`.

Same contract as `libdocs`, `rtk` and `watermarks`: what the settings screen
writes to `.workpilot/.env` reaches the preflight, and a real environment
variable wins over the file.
"""

from __future__ import annotations

import os
from pathlib import Path

ENABLED_ENV = "DOCINTEL_ENABLED"
LOCAL_OCR_ENV = "DOCINTEL_LOCAL_OCR"
OCR_LANGS_ENV = "DOCINTEL_OCR_LANGS"
MAX_BYTES_ENV = "DOCINTEL_MAX_BYTES"
TESSERACT_PATH_ENV = "WORKPILOT_TESSERACT_PATH"
OCR_ENGINE_ENV = "DOCINTEL_OCR_ENGINE"
VISION_MODEL_ENV = "DOCINTEL_VISION_MODEL"
AZURE_ENDPOINT_ENV = "DOCINTEL_AZURE_ENDPOINT"
AZURE_KEY_ENV = "DOCINTEL_AZURE_KEY"
PDF_MAX_PAGES_ENV = "DOCINTEL_PDF_MAX_PAGES"

_KEYS = (
    ENABLED_ENV,
    LOCAL_OCR_ENV,
    OCR_LANGS_ENV,
    MAX_BYTES_ENV,
    TESSERACT_PATH_ENV,
    OCR_ENGINE_ENV,
    VISION_MODEL_ENV,
    AZURE_ENDPOINT_ENV,
    AZURE_KEY_ENV,
    PDF_MAX_PAGES_ENV,
)

DEFAULT_MAX_BYTES = 10 * 1024 * 1024
#: The two languages the product ships in. Tesseract refuses a language whose
#: data is not installed, and `ocr.py` retries without `-l` when it does.
DEFAULT_OCR_LANGS = "eng+fra"
#: The fallback chain when nothing is configured: the one engine that needs no
#: Python stack and that the previous release already used.
DEFAULT_OCR_ENGINES = ("tesseract",)
#: Used only when `ollama-vision` is in the chain. Pulling it is the person's
#: call (`ollama pull qwen2.5vl`); an absent model is a recorded reason.
DEFAULT_VISION_MODEL = "qwen2.5vl"
#: Pages of a scanned PDF rendered and OCR'd per build. A specification is a
#: few dozen pages; an annex of three hundred scanned invoices is not what the
#: task is about, and OCR costs a second or two a page.
DEFAULT_PDF_MAX_PAGES = 20


def project_env(project_dir: Path | None) -> dict[str, str]:
    """The environment, with `.workpilot/.env` underneath it."""
    values: dict[str, str] = {}
    if project_dir is not None:
        path = Path(project_dir) / ".workpilot" / ".env"
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, raw = line.split("=", 1)
            if key.strip() in _KEYS:
                values[key.strip()] = raw.strip().strip("\"'")
    for key in _KEYS:
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def _flag(env: dict[str, str], key: str) -> bool:
    return str(env.get(key, "true")).strip().lower() not in ("false", "0", "no", "off")


def is_enabled(env: dict[str, str]) -> bool:
    return _flag(env, ENABLED_ENV)


def local_ocr_enabled(env: dict[str, str]) -> bool:
    return _flag(env, LOCAL_OCR_ENV)


def ocr_engines(env: dict[str, str]) -> tuple[str, ...]:
    """The ordered fallback chain, lower-cased, each name once."""
    raw = str(env.get(OCR_ENGINE_ENV) or "").replace(";", ",")
    names: list[str] = []
    for part in raw.split(","):
        name = part.strip().lower()
        if name and name not in names:
            names.append(name)
    return tuple(names) or DEFAULT_OCR_ENGINES


def vision_model(env: dict[str, str]) -> str:
    return str(env.get(VISION_MODEL_ENV) or DEFAULT_VISION_MODEL).strip()


def azure_endpoint(env: dict[str, str]) -> str:
    return str(env.get(AZURE_ENDPOINT_ENV) or "").strip()


def azure_key(env: dict[str, str]) -> str:
    return str(env.get(AZURE_KEY_ENV) or "").strip()


def ocr_langs(env: dict[str, str]) -> str:
    return str(env.get(OCR_LANGS_ENV) or DEFAULT_OCR_LANGS).strip()


def max_bytes(env: dict[str, str]) -> int:
    """A nonsense value falls back to the default rather than disabling."""
    try:
        value = int(str(env.get(MAX_BYTES_ENV, "")).strip())
    except ValueError:
        return DEFAULT_MAX_BYTES
    return value if value > 0 else DEFAULT_MAX_BYTES


def pdf_max_pages(env: dict[str, str]) -> int:
    """Same rule as `max_bytes`: a nonsense value is the default, never "none"."""
    try:
        value = int(str(env.get(PDF_MAX_PAGES_ENV, "")).strip())
    except ValueError:
        return DEFAULT_PDF_MAX_PAGES
    return value if value > 0 else DEFAULT_PDF_MAX_PAGES
