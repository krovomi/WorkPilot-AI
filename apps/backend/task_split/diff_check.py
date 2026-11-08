"""After the code: the card's real diff, against its ceiling.

The split decides on the plan's estimate, before any code. Once the build has
written and QA has corrected the branch, its diff says what the reviewer will
really read: ``git diff --numstat base...HEAD`` (rename-aware), each file
weighed by ``review_load`` (code 1, tests and docs 0.5, generated 0, a
deleted line a quarter, a deleted file one line). The result goes in the
card's ``task_metadata.json`` as ``splitCheck``, and the board shows a card
above its ceiling. Nothing is cut again: the code is written, and only a
person can choose to split a finished branch.

The ceiling is the card's own (``policy``), the same for a part of a split
and for a card built whole. A card that is never split (its kind, the
project's switch, ``noSplit``) is not measured.
"""

from __future__ import annotations

import json
import logging
import math
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

from .policy import resolve_policy
from .review_load import changed_lines_load, file_weight

logger = logging.getLogger(__name__)

__all__ = [
    "DiffCheck",
    "check_diff",
    "measure_rows",
    "parse_numstat",
    "record_diff_check",
]

METADATA_FILE = "task_metadata.json"


@dataclass(frozen=True)
class DiffCheck:
    """The lines to review and the files of a finished branch, and its ceilings."""

    lines: int
    files: int
    max_lines: int
    max_files: int
    kind: str

    @property
    def over(self) -> bool:
        return self.lines > self.max_lines or self.files > self.max_files

    def to_metadata(self, now: str | None = None) -> dict[str, Any]:
        return {
            "lines": self.lines,
            "files": self.files,
            "maxLines": self.max_lines,
            "maxFiles": self.max_files,
            "kind": self.kind,
            "over": self.over,
            "checkedAt": now or datetime.now(UTC).isoformat(),
        }


def parse_numstat(raw: str) -> list[tuple[str, int, int]]:
    """``git diff --numstat -z`` as ``(path, added, deleted)`` rows.

    With ``-z`` a row is ``added\\tdeleted\\tpath\\0``, or for a rename
    ``added\\tdeleted\\t\\0old\\0new\\0``: the new path is the one kept. A
    binary file prints ``-`` for both counts and counts no line.
    """
    fields = raw.split("\0")
    rows: list[tuple[str, int, int]] = []
    i = 0
    while i < len(fields):
        head = fields[i]
        i += 1
        if not head:
            continue
        parts = head.split("\t", 2)
        if len(parts) != 3:
            continue
        added, deleted, path = parts
        if not path:  # a rename: the two paths follow
            if i + 1 >= len(fields):
                break
            path = fields[i + 1]
            i += 2
        rows.append(
            (
                path,
                int(added) if added.isdecimal() else 0,
                int(deleted) if deleted.isdecimal() else 0,
            )
        )
    return rows


def measure_rows(
    rows: Iterable[tuple[str, int, int]], deleted_files: Iterable[str] = ()
) -> tuple[int, int]:
    """(lines to review, files that count) for numstat rows. Pure."""
    gone = set(deleted_files)
    load = 0.0
    files = 0
    for path, added, deleted in rows:
        if file_weight(path) > 0:
            files += 1
        load += changed_lines_load(path, added, deleted, file_deleted=path in gone)
    return math.ceil(load), files


def _measure_from(worktree: Path, base: str) -> tuple[int, int] | None:
    span = f"{base}...HEAD"
    stat = run_git(["diff", "--numstat", "-z", "-M", span], cwd=worktree, timeout=120)
    if stat.returncode != 0:
        return None
    gone = run_git(
        ["diff", "--name-only", "-z", "--diff-filter=D", span],
        cwd=worktree,
        timeout=120,
    )
    deleted = [p for p in gone.stdout.split("\0") if p] if gone.returncode == 0 else []
    return measure_rows(parse_numstat(stat.stdout), deleted)


def _measure(worktree: Path, base: str) -> tuple[int, int] | None:
    """The branch's diff from ``base``, or from ``origin/<base>`` when closer.

    A worktree often starts from the remote base while the local one lags:
    measured from the local one, the diff would count the remote's commits
    too. The closer base is the one with the smaller diff.
    """
    if not base or base.startswith("-"):
        return None
    results = [
        measured
        for ref in (base, f"origin/{base}")
        if (measured := _measure_from(worktree, ref)) is not None
    ]
    return min(results, default=None)


def check_diff(
    metadata: Mapping[str, Any] | None,
    worktree: Path,
    base: str,
    env: Mapping[str, str] | None = None,
) -> DiffCheck | None:
    """The check of ``worktree``'s branch, or None when the card is not measured."""
    policy = resolve_policy(metadata, env)
    if not policy.enabled:
        return None
    measured = _measure(Path(worktree), base)
    if measured is None:
        return None
    lines, files = measured
    return DiffCheck(lines, files, policy.max_lines, policy.max_files, policy.kind)


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(path: Path, data: dict) -> None:
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(partial, path)


def record_diff_check(
    spec_dirs: Iterable[Path | None], worktree: Path, base: str
) -> DiffCheck | None:
    """Measure the branch and write ``splitCheck`` in every copy of the card.

    Never raises: a check that cannot run leaves the card as it was.
    """
    dirs = [Path(d) for d in dict.fromkeys(spec_dirs) if d is not None]
    if not dirs:
        return None
    try:
        result = check_diff(_read(dirs[0] / METADATA_FILE), worktree, base)
        if result is None:
            return None
        entry = result.to_metadata()
        for directory in dirs:
            path = directory / METADATA_FILE
            if not path.parent.is_dir():
                continue
            metadata = _read(path)
            metadata["splitCheck"] = entry
            _write(path, metadata)
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("diff check skipped: %s", exc)
        return None
    return result
