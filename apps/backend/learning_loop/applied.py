"""The lessons a task's prompts carried, and the ones its person turned off.

Every prompt that asks the Learning Loop for its lessons with a spec directory
in hand (the spec writer and its critic, the planner, the coder, the QA
reviewer and fixer) records what it was given in ``applied_lessons.json``, in
that spec directory: the project's adopted rules, the patterns ranked by
confidence, the checkpoints of the task's kind (``kind_checkpoints``). The
task panel reads the file to say "N lessons applied to this task", and lets
the person turn one off for this task alone: its id goes to ``disabled``, and
every later prompt of the task leaves it out. The lesson itself stays on for
every other task.

The desktop app writes ``disabled``, in every copy of the spec directory
(``main/ipc-handlers/task/applied-lessons-handlers.ts``); this module writes
``lessons`` in the copy the prompt ran from, and the app reads them all. Each
keeps the other's field as it found it.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

APPLIED_FILE = "applied_lessons.json"
#: Lessons kept in the file; the oldest go first.
MAX_RECORDED = 60
#: A lesson id as this module and the app accept it.
LESSON_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_MAX_TEXT = 600


@dataclass(frozen=True)
class Lesson:
    id: str
    #: ``rule`` (adopted from a review), ``pattern`` (mined from builds) or
    #: ``checkpoint`` (the task's kind, when this repository's history asks).
    kind: str
    text: str
    #: The agent that was given it: ``spec_writer``, ``planner``, ``coder``…
    agent: str
    pattern_type: str | None = None
    confidence: float | None = None


def _read(spec_dir: Path) -> dict[str, Any]:
    path = Path(spec_dir) / APPLIED_FILE
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def disabled_ids(spec_dir: Path | None) -> frozenset[str]:
    """The lessons the person turned off for this task."""
    if spec_dir is None:
        return frozenset()
    raw = _read(spec_dir).get("disabled")
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(i for i in raw if isinstance(i, str) and LESSON_ID.match(i))


def applied(spec_dir: Path) -> list[dict[str, Any]]:
    raw = _read(spec_dir).get("lessons")
    return (
        [row for row in raw if isinstance(row, dict)] if isinstance(raw, list) else []
    )


def record(spec_dir: Path | None, lessons: list[Lesson]) -> None:
    """Add what a prompt carried; a lesson given again moves to the end. Never raises."""
    if spec_dir is None or not lessons:
        return
    folder = Path(spec_dir)
    if not folder.is_dir() or folder.is_symlink():
        return
    data = _read(folder)
    now = datetime.now(UTC).isoformat()
    fresh = {(lesson.id, lesson.agent) for lesson in lessons}
    rows = [
        row for row in applied(folder) if (row.get("id"), row.get("agent")) not in fresh
    ]
    for lesson in lessons:
        if not LESSON_ID.match(lesson.id):
            continue
        row = {k: v for k, v in asdict(lesson).items() if v is not None}
        row["text"] = lesson.text[:_MAX_TEXT]
        row["at"] = now
        rows.append(row)
    data["lessons"] = rows[-MAX_RECORDED:]
    data.setdefault("disabled", [])
    _write(folder / APPLIED_FILE, data)


def _write(path: Path, data: dict[str, Any]) -> None:
    """Atomic; what a prompt carried is a record for the panel, never a reason to fail."""
    try:
        handle, temp = tempfile.mkstemp(
            dir=path.parent, prefix=".applied-", suffix=".json"
        )
    except OSError:
        return
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(data, out, indent=2, ensure_ascii=False)
        os.replace(temp, path)
    except OSError:
        Path(temp).unlink(missing_ok=True)


__all__ = [
    "APPLIED_FILE",
    "LESSON_ID",
    "Lesson",
    "applied",
    "disabled_ids",
    "record",
]
