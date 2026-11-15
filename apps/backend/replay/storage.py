"""Where the replay features keep one record per id on disk.

Ids name files: one is accepted only when it can be nothing but a file name
in its folder (letters, digits, ``-`` and ``_``), as the ids the recorder and
the time-travel engine create are.
"""

from __future__ import annotations

import re
from pathlib import Path

_STORED_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


def record_file(directory: Path, record_id: object, prefix: str = "") -> Path | None:
    """``<directory>/<prefix><record_id>.json``, or ``None`` for an id that is not one."""
    if not isinstance(record_id, str) or not _STORED_ID.fullmatch(record_id):
        return None
    path = directory / f"{prefix}{record_id}.json"
    if path.resolve().parent != directory.resolve():
        return None
    return path


def require_record_file(directory: Path, record_id: object, prefix: str = "") -> Path:
    """`record_file`, refusing an id that is not one."""
    path = record_file(directory, record_id, prefix)
    if path is None:
        raise ValueError("not a replay record id")
    return path
