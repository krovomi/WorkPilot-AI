"""Where a personal style profile lives, and what may be written into it.

Per project, in ``.workpilot/coach/`` (ignored by git): ``profile.json``, what
the history says; ``preferences.json``, what the person set by hand, which
wins. Every value comes from a closed list (``DIMENSIONS``, ``LANGUAGES``), so
nothing the renderer or an imported file sends can put free text into a
prompt (S2, S6).

An export carries the effective preferences only: no email, no path, no code.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from .style_dimensions import DIMENSIONS, LANGUAGES

__all__ = [
    "EXPORT_FORMAT",
    "PREFERENCES",
    "PROFILE",
    "coaching_active",
    "effective",
    "export_profile",
    "import_profile",
    "load_preferences",
    "load_profile",
    "read_overrides",
    "save_preferences",
    "save_profile",
]

PROFILE = Path(".workpilot") / "coach" / "profile.json"
PREFERENCES = Path(".workpilot") / "coach" / "preferences.json"
EXPORT_FORMAT = "workpilot-coach-profile"
OFF = "off"
MAX_BYTES = 1024 * 1024
_KNOWN_LANGUAGES = frozenset(LANGUAGES.values())


def _folder(root: Path, create: bool) -> Path | None:
    workpilot = root / ".workpilot"
    if workpilot.is_symlink() or not workpilot.is_dir():
        return None
    coach = workpilot / "coach"
    if coach.is_symlink():
        return None
    if create:
        coach.mkdir(exist_ok=True)
    return coach if coach.is_dir() else None


def _read_json(path: Path) -> Any:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(root: Path, relative: Path, data: Any) -> bool:
    folder = _folder(root, create=True)
    if folder is None:
        return False
    target = root / relative
    if target.is_symlink():
        return False
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return True


def read_overrides(raw: Any) -> dict[str, dict[str, str]]:
    """Keep only known languages, dimensions and values (or ``off``)."""
    overrides: dict[str, dict[str, str]] = {}
    if not isinstance(raw, dict):
        return overrides
    for language, dims in raw.items():
        if language not in _KNOWN_LANGUAGES or not isinstance(dims, dict):
            continue
        kept = {
            dim: value
            for dim, value in dims.items()
            if dim in DIMENSIONS
            and isinstance(value, str)
            and (value == OFF or value in DIMENSIONS[dim])
        }
        if kept:
            overrides[language] = kept
    return overrides


def load_profile(root: Path) -> dict | None:
    data = _read_json(root / PROFILE)
    return (
        data
        if isinstance(data, dict) and isinstance(data.get("languages"), dict)
        else None
    )


def save_profile(root: Path, profile: dict) -> bool:
    return _write_json(root, PROFILE, profile)


def load_preferences(root: Path) -> dict:
    data = _read_json(root / PREFERENCES)
    data = data if isinstance(data, dict) else {}
    return {
        "enabled": data.get("enabled") is not False,
        "overrides": read_overrides(data.get("overrides")),
    }


def save_preferences(root: Path, enabled: bool, overrides: Any) -> dict:
    preferences = {"enabled": bool(enabled), "overrides": read_overrides(overrides)}
    if not _write_json(root, PREFERENCES, preferences):
        raise ValueError("the project has no .workpilot folder")
    return preferences


def effective(profile: dict | None, preferences: dict) -> dict[str, dict[str, str]]:
    """Language → dimension → value: a confident measure, unless the person set it."""
    result: dict[str, dict[str, str]] = {}
    for language, dims in ((profile or {}).get("languages") or {}).items():
        if language not in _KNOWN_LANGUAGES or not isinstance(dims, dict):
            continue
        for dim, entry in dims.items():
            if (
                dim in DIMENSIONS
                and isinstance(entry, dict)
                and entry.get("state") == "preferred"
                and entry.get("value") in DIMENSIONS[dim]
            ):
                result.setdefault(language, {})[dim] = entry["value"]
    for language, dims in preferences.get("overrides", {}).items():
        for dim, value in dims.items():
            if value == OFF:
                result.get(language, {}).pop(dim, None)
            else:
                result.setdefault(language, {})[dim] = value
    return {language: dims for language, dims in result.items() if dims}


def coaching_active(root: Path) -> bool:
    """True when the agents of this project are given a style."""
    preferences = load_preferences(root)
    return preferences["enabled"] and bool(effective(load_profile(root), preferences))


def export_profile(root: Path) -> dict:
    preferences = load_preferences(root)
    return {
        "format": EXPORT_FORMAT,
        "version": 1,
        "exportedAt": int(time.time()),
        "preferences": effective(load_profile(root), preferences),
    }


def import_profile(root: Path, data: Any) -> dict:
    """Take an export's preferences as the person's own; returns the new preferences."""
    if (
        not isinstance(data, dict)
        or data.get("format") != EXPORT_FORMAT
        or data.get("version") != 1
    ):
        raise ValueError("not a WorkPilot coach profile")
    imported = read_overrides(data.get("preferences"))
    if not imported:
        raise ValueError("the profile holds no preference")
    preferences = load_preferences(root)
    merged = {
        language: dict(dims) for language, dims in preferences["overrides"].items()
    }
    for language, dims in imported.items():
        merged.setdefault(language, {}).update(dims)
    return save_preferences(root, preferences["enabled"], merged)
