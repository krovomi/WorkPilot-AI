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

_KEYS = (ENABLED_ENV, LOCAL_OCR_ENV, OCR_LANGS_ENV, MAX_BYTES_ENV, TESSERACT_PATH_ENV)

DEFAULT_MAX_BYTES = 10 * 1024 * 1024
#: The two languages the product ships in. Tesseract refuses a language whose
#: data is not installed, and `ocr.py` retries without `-l` when it does.
DEFAULT_OCR_LANGS = "eng+fra"


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


def ocr_langs(env: dict[str, str]) -> str:
    return str(env.get(OCR_LANGS_ENV) or DEFAULT_OCR_LANGS).strip()


def max_bytes(env: dict[str, str]) -> int:
    """A nonsense value falls back to the default rather than disabling."""
    try:
        value = int(str(env.get(MAX_BYTES_ENV, "")).strip())
    except ValueError:
        return DEFAULT_MAX_BYTES
    return value if value > 0 else DEFAULT_MAX_BYTES
