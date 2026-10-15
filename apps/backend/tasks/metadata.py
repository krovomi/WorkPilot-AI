"""Reading and recording a card's kind in ``task_metadata.json``.

The file is written by the desktop app when the card is created (and on
``task:update``), read by the spec pipeline and the build. This module adds
the kind without disturbing the rest, and never overwrites a kind the user
chose in the UI.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .classify import Classification, classify

logger = logging.getLogger(__name__)

__all__ = ["read_task_metadata", "record_kind", "classify_spec"]

METADATA_FILE = "task_metadata.json"


def read_task_metadata(spec_dir: Path) -> dict[str, Any]:
    """The card's metadata, or ``{}`` when the file is absent or unreadable."""
    path = Path(spec_dir) / METADATA_FILE
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("could not read %s: %s", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


def record_kind(spec_dir: Path, classification: Classification) -> dict[str, Any]:
    """Write the kind into ``task_metadata.json``; the user's choice wins.

    Returns the metadata as written. A write failure is logged, never raised:
    the kind is context for later lots, not a condition of the build.
    """
    path = Path(spec_dir) / METADATA_FILE
    metadata = read_task_metadata(spec_dir)
    if metadata.get("kindSource") == "user" and metadata.get("kind"):
        return metadata
    metadata.update(classification.as_metadata())
    try:
        path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("could not write %s: %s", path, exc)
    return metadata


def classify_spec(spec_dir: Path, title: str, description: str = "") -> Classification:
    """Classify a card from its spec directory and record the verdict."""
    metadata = read_task_metadata(spec_dir)
    verdict = classify(title, description, metadata)
    record_kind(spec_dir, verdict)
    logger.info(
        "task kind: %s (%.2f, %s) — %s",
        verdict.kind.value,
        verdict.confidence,
        verdict.source,
        "; ".join(verdict.reasons),
    )
    return verdict
