"""The change set a task is *about to* make, read from its plan.

`when: touches(...)` is evaluated against changed files, and before coding there
are none: the first resolution has no change set, so `_touched` answers "run" —
the safe direction, and the reason a phase guarding web design ran on every
backend task too. Once the planner has written `implementation_plan.json`, the
files every subtask declares (`files_to_modify`, `files_to_create`) are a
forecast good enough to decide a phase that runs *before* the code exists.

A forecast, not a fact: the plan can be wrong, and the post-coding resolution
still reads the real diff. An empty forecast is `None` — "unknown" — never `[]`,
because `[]` would mean "touches nothing" and skip every conditional phase.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

__all__ = ["PLAN_FILE", "planned_files", "subtask_files"]

PLAN_FILE = "implementation_plan.json"

_FILE_KEYS = ("files_to_modify", "files_to_create")


def subtask_files(subtask: Any) -> list[str]:
    """The files one subtask declares, in order, without duplicates."""
    if not isinstance(subtask, dict):
        return []
    out: list[str] = []
    for key in _FILE_KEYS:
        value = subtask.get(key)
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, dict):
                item = item.get("path") or item.get("file")
            if isinstance(item, str) and item.strip() and item.strip() not in out:
                out.append(item.strip())
    return out


def planned_files(spec_dir: Path | str | None) -> list[str] | None:
    """Every file the plan's subtasks declare, or ``None`` when unknown."""
    if not spec_dir:
        return None
    try:
        plan = json.loads((Path(spec_dir) / PLAN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(plan, dict):
        return None
    phases = plan.get("phases")
    if not isinstance(phases, list):
        return None
    files: list[str] = []
    for phase in phases:
        subtasks = phase.get("subtasks") if isinstance(phase, dict) else None
        for subtask in subtasks if isinstance(subtasks, list) else []:
            for path in subtask_files(subtask):
                if path not in files:
                    files.append(path)
    return files or None
