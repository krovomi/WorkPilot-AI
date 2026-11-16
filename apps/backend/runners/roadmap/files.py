"""The files a roadmap agent writes, as the phases check them."""

import json
from pathlib import Path


def snapshot(path: Path) -> tuple[int, bytes] | None:
    """What a file holds now (and when it was written), or None if it is absent."""
    try:
        return path.stat().st_mtime_ns, path.read_bytes()
    except OSError:
        return None


def written_since(path: Path, before: tuple[int, bytes] | None) -> bool:
    """Whether an agent wrote the file after ``before`` was taken.

    With --refresh the previous run's file is still there: an agent that
    writes nothing must not have it taken for its own work.
    """
    now = snapshot(path)
    return now is not None and now != before


def read_object(path: Path) -> dict | None:
    """A JSON object from an agent's file, or None if it is not one."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
