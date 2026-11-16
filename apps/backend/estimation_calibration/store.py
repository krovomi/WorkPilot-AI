"""Where a repository's calibration lives: ``.workpilot/estimation/calibration.json``.

One file per project, written under ``foundation.json_ledger`` so two merges
in two processes never drop each other's sample. A sample is keyed by its
spec: a spec merged twice keeps its latest outcome. A ``.workpilot`` (or
``estimation``) folder that is a symbolic link is neither read nor written,
so a repository cannot point the ledger at a file elsewhere on the disk.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from foundation.json_ledger import update_json

RELATIVE = Path(".workpilot") / "estimation" / "calibration.json"
#: Oldest entries are dropped past this, so the file stays small.
MAX_ENTRIES = 500


def _empty() -> dict[str, Any]:
    return {"version": 1, "samples": [], "adjustments": [], "reset_at": None}


def _normalize(data: object) -> dict[str, Any]:
    if not isinstance(data, dict):
        return _empty()
    out = _empty()
    for key in ("samples", "adjustments"):
        value = data.get(key)
        out[key] = (
            [e for e in value if isinstance(e, dict)] if isinstance(value, list) else []
        )
    reset_at = data.get("reset_at")
    out["reset_at"] = reset_at if isinstance(reset_at, str) else None
    return out


def path_for(root: Path) -> Path | None:
    """The calibration file of *root*, or None when a folder on the way is a link."""
    workpilot = root / ".workpilot"
    folder = workpilot / "estimation"
    if workpilot.is_symlink() or folder.is_symlink():
        return None
    return root / RELATIVE


def load(root: Path) -> dict[str, Any]:
    """The calibration of *root*; an empty one when there is none or it is unreadable."""
    target = path_for(root)
    if target is None or target.is_symlink():
        return _empty()
    try:
        return _normalize(json.loads(target.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return _empty()


def _update(root: Path, change) -> dict[str, Any] | None:
    target = path_for(root)
    if target is None or target.is_symlink():
        return None
    return update_json(target, _empty, lambda data: change(_normalize(data)))


def _now() -> str:
    return datetime.now(UTC).isoformat()


def record_sample(root: Path, sample: dict[str, Any]) -> dict[str, Any] | None:
    """Keep *sample* (estimated against actual) for its spec; returns the file written."""
    entry = {**sample, "at": _now()}

    def change(data: dict[str, Any]) -> dict[str, Any]:
        kept = [s for s in data["samples"] if s.get("spec") != entry.get("spec")]
        data["samples"] = [*kept, entry][-MAX_ENTRIES:]
        return data

    return _update(root, change)


def record_adjustment(
    root: Path, category: str, base_score: int, adjusted_score: int
) -> dict[str, Any] | None:
    """Keep a person's own complexity score against the estimator's."""
    entry = {
        "category": category,
        "base_score": base_score,
        "adjusted_score": adjusted_score,
        "at": _now(),
    }

    def change(data: dict[str, Any]) -> dict[str, Any]:
        data["adjustments"] = [*data["adjustments"], entry][-MAX_ENTRIES:]
        return data

    return _update(root, change)


def reset(root: Path) -> dict[str, Any] | None:
    """Forget every sample and adjustment (after a redesign of the repository)."""

    def change(_data: dict[str, Any]) -> dict[str, Any]:
        return {**_empty(), "reset_at": _now()}

    return _update(root, change)
