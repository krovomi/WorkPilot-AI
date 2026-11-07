"""Review comments anchored on a line: ``review-comments.json`` in the spec dir.

The person comments a line of the task's diff in the review; "Request
changes" puts the open comments into ``QA_FIX_REQUEST.md`` (the desktop app
writes both). After the QA fixer's session, **the orchestrator**, never the
model, decides which comments the session addressed: one is ``addressed``
when the session's diff touches the lines it is anchored on. Only the person
moves a comment to ``resolved``.

A comment is anchored by the commit it was written on and an excerpt of the
lines around it. Lines move: the comment is found again by its excerpt in the
file as the session found it. When the excerpt is no longer there, the
comment is ``stale``, never moved to a guessed line.

The file is written in every copy of the spec directory by the desktop app;
this module updates the copy the build runs in (the worktree's). Readers take
the union of the copies by id, the newest ``updated_at`` winning
(``frontend/src/shared/utils/review-comments.ts`` does the same).
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

logger = logging.getLogger(__name__)

__all__ = [
    "REVIEW_COMMENTS_FILE",
    "load_comments",
    "mark_addressed",
    "touched_ranges",
]

REVIEW_COMMENTS_FILE = "review-comments.json"
#: Lines around the anchor that count as "touching" it.
_SLACK = 1
_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")
_HEX = re.compile(r"^[0-9a-f]{7,64}$")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_comments(spec_dir: Path) -> list[dict]:
    """The comments of one copy; malformed entries dropped, never raises."""
    try:
        data = json.loads((spec_dir / REVIEW_COMMENTS_FILE).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        logger.warning("could not read %s: %s", REVIEW_COMMENTS_FILE, exc)
        return []
    comments = data.get("comments") if isinstance(data, dict) else None
    if not isinstance(comments, list):
        return []
    return [
        c
        for c in comments
        if isinstance(c, dict)
        and isinstance(c.get("id"), str)
        and isinstance(c.get("path"), str)
        and isinstance(c.get("line"), int)
    ]


def _save(spec_dir: Path, comments: list[dict]) -> None:
    payload = json.dumps({"comments": comments}, ensure_ascii=False, indent=2)
    fd, tmp = tempfile.mkstemp(dir=spec_dir, prefix=".review-comments-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        os.replace(tmp, spec_dir / REVIEW_COMMENTS_FILE)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


def touched_ranges(diff: str) -> dict[str, list[tuple[int, int]]]:
    """Old-side line ranges each file's hunks change, ``(first, last)`` inclusive.

    A pure insertion (``-12,0``) touches the line it follows and the next one.
    """
    ranges: dict[str, list[tuple[int, int]]] = {}
    path: str | None = None
    for line in diff.splitlines():
        if line.startswith("--- "):
            old = line[4:].strip()
            path = old[2:] if old.startswith("a/") else None
            continue
        if line.startswith("+++ ") and path is None:
            new = line[4:].strip()
            path = new[2:] if new.startswith("b/") else None
            continue
        match = _HUNK.match(line)
        if match and path:
            start = int(match.group(1))
            count = 1 if match.group(2) is None else int(match.group(2))
            first, last = (
                (start, start + 1) if count == 0 else (start, start + count - 1)
            )
            ranges.setdefault(path, []).append((first, last))
    return ranges


def _locate(lines: list[str], comment: dict) -> int | None:
    """The comment's line in ``lines``, found by its excerpt; None if gone."""
    excerpt = comment.get("excerpt")
    if not isinstance(excerpt, list) or not excerpt:
        return None
    wanted = [str(e).strip() for e in excerpt]
    offset = comment.get("excerpt_offset", 0)
    offset = offset if isinstance(offset, int) and 0 <= offset < len(wanted) else 0
    expected = comment["line"] - offset
    starts = [
        i
        for i in range(len(lines) - len(wanted) + 1)
        if [ln.strip() for ln in lines[i : i + len(wanted)]] == wanted
    ]
    if not starts:
        return None
    best = min(starts, key=lambda i: abs((i + 1) - expected))
    return best + 1 + offset


def _span(comment: dict) -> int:
    """How many lines after the anchor the comment covers (a range)."""
    end = comment.get("end_line")
    return max(0, end - comment["line"]) if isinstance(end, int) else 0


def mark_addressed(
    spec_dir: Path,
    project_dir: Path,
    commit_before: str | None,
    *,
    session: int | None = None,
) -> int:
    """After the fixer's session: open comments its diff touches become
    ``addressed``; one whose excerpt is gone becomes ``stale``. Never raises.
    Returns how many comments changed."""
    comments = load_comments(spec_dir)
    # A comment on a removed line (``side == "old"``) has nothing to find in
    # the worktree: it stays open until the person resolves it.
    open_comments = [
        c
        for c in comments
        if c.get("status", "open") == "open" and c.get("side", "new") == "new"
    ]
    if not open_comments or not commit_before or not _HEX.match(commit_before):
        return 0
    try:
        diff = run_git(
            ["diff", "--no-color", "-U0", commit_before, "--"], cwd=project_dir
        )
        if diff.returncode != 0:
            return 0
        touched = touched_ranges(diff.stdout)
        changed = 0
        for comment in open_comments:
            path = comment["path"]
            shown = run_git(["show", f"{commit_before}:{path}"], cwd=project_dir)
            if shown.returncode != 0:
                continue  # not in that commit (deleted earlier, or never there)
            line = _locate(shown.stdout.splitlines(), comment)
            if line is None:
                comment.update(status="stale", updated_at=_now())
                changed += 1
            elif any(
                first <= line + _span(comment) + _SLACK and last >= line - _SLACK
                for first, last in touched.get(path, [])
            ):
                comment.update(
                    status="addressed",
                    updated_at=_now(),
                    addressed_session=session,
                )
                changed += 1
        if changed:
            _save(spec_dir, comments)
        return changed
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("could not update the review comments: %s", exc)
        return 0
