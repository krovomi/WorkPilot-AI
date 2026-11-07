"""The lines a range of commits added, read from git, whatever the provider.

Git is the source of truth for attribution: a CLI agent (OpenCode, Codex, pi,
Gemini over ACP…) writes its own files without going through WorkPilot's
hooks, but every session's work ends up between two commits. The diff between
them gives the new-side line ranges; the content of each range is hashed so a
range can be found again after it moved (a rebase, a reformat above it).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from foundation.git_executable import run_git

__all__ = [
    "added_ranges",
    "file_lines",
    "line_hash",
    "range_hash",
    "spans",
]

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
#: A generated or vendored file is nobody's authorship question.
_IGNORED_DIRS = frozenset(
    {"node_modules", "vendor", "dist", "build", "target", "bin", "obj", ".git"}
)
#: A diff larger than this (a vendored drop, a generated bundle) is not read.
MAX_DIFF_CHARS = 8 * 1024 * 1024


def _kept(path: str) -> bool:
    parts = path.split("/")
    return not any(p in _IGNORED_DIRS for p in parts[:-1]) and not parts[0].startswith(
        ".workpilot"
    )


def line_hash(text: str) -> str:
    """A line's identity: its text without trailing whitespace or line ending."""
    return hashlib.sha256(text.rstrip().encode("utf-8")).hexdigest()[:16]


def range_hash(lines: list[str]) -> str:
    """The ``content_hash`` of a range, in the spec's ``algorithm:hex`` form."""
    joined = "\n".join(line.rstrip() for line in lines)
    return "sha256:" + hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def spans(lines: set[int]) -> list[tuple[int, int]]:
    """``{3, 4, 5, 9}`` → ``[(3, 5), (9, 9)]``."""
    out: list[tuple[int, int]] = []
    for line in sorted(lines):
        if out and line == out[-1][1] + 1:
            out[-1] = (out[-1][0], line)
        else:
            out.append((line, line))
    return out


def added_ranges(project_dir: Path, base: str, head: str) -> dict[str, set[int]]:
    """``{path: {line, …}}``: the new-side lines ``base..head`` added.

    Raises ``OSError`` when git cannot answer; the caller records nothing.
    """
    result = run_git(
        [
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "-U0",
            base,
            head,
        ],
        cwd=project_dir,
        timeout=120,
    )
    if result.returncode != 0:
        raise OSError(f"git diff failed: {result.stderr.strip()[:200]}")
    if len(result.stdout) > MAX_DIFF_CHARS:
        raise OSError("diff too large to attribute")
    lines: dict[str, set[int]] = {}
    path: str | None = None
    for row in result.stdout.splitlines():
        if row.startswith("+++ "):
            target = row[4:].strip()
            path = target[2:] if target.startswith("b/") and _kept(target[2:]) else None
            continue
        match = _HUNK.match(row)
        if match and path:
            start = int(match.group(1))
            count = 1 if match.group(2) is None else int(match.group(2))
            if count:
                lines.setdefault(path, set()).update(range(start, start + count))
    return lines


def file_lines(project_dir: Path, revision: str, path: str) -> list[str] | None:
    """The file's lines at ``revision``, or None (deleted, binary, unreadable)."""
    result = run_git(["show", f"{revision}:{path}"], cwd=project_dir, timeout=30)
    if result.returncode != 0 or "\0" in result.stdout[:8000]:
        return None
    return result.stdout.splitlines()
