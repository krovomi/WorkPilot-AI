"""Whether the task changed what the goal says it may not change.

The cheapest way to make ``pytest`` exit 0 is to edit the tests. A goal lists
the paths that define "done" (``tests/**``, the script the command runs), and
the gate reads the task's real change set against them before it believes an
exit code.

The change set is the worktree against the point it forked from: committed,
staged, unstaged and untracked, with renames split into a deletion and an
addition so that moving a test out of the suite shows on both names. When
that point cannot be found the answer is "unknown", and an unknown change set
never lets a goal pass.
"""

from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path

from foundation.git_executable import get_git_executable

__all__ = ["changed_paths", "matches", "protected_changes"]


def _git(worktree: Path, *args: str) -> tuple[int, str]:
    try:
        done = subprocess.run(  # noqa: S603 - fixed argv
            [get_git_executable(), *args],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return done.returncode, done.stdout


def _fork_point(worktree: Path, bases: list[str]) -> str | None:
    for base in bases:
        code, out = _git(worktree, "merge-base", "HEAD", base)
        if code == 0 and out.strip():
            return out.strip()
    return None


def changed_paths(worktree: Path, bases: list[str]) -> list[str] | None:
    """Every path the task touched, or None when its fork point is unknown."""
    fork = _fork_point(worktree, bases)
    if fork is None:
        return None
    code, diff = _git(worktree, "diff", "--name-only", "--no-renames", "-z", fork, "--")
    if code != 0:
        return None
    code, untracked = _git(worktree, "ls-files", "--others", "--exclude-standard", "-z")
    if code != 0:
        return None
    paths = [p for p in (diff + untracked).split("\0") if p]
    return list(dict.fromkeys(paths))


@lru_cache(maxsize=256)
def _compile(pattern: str) -> re.Pattern[str]:
    """A repository glob: ``*`` stays in a directory, ``**`` crosses them.

    A pattern with no wildcard names a file or a whole directory (``tests``
    and ``tests/`` both cover ``tests/unit/test_x.py``).
    """
    pattern = pattern.strip("/")
    if not any(c in pattern for c in "*?["):
        return re.compile(re.escape(pattern) + r"(?:/.*)?")
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append(r"(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(r".*")
            i += 2
        elif pattern[i] == "*":
            out.append(r"[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append(r"[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out))


def matches(path: str, pattern: str) -> bool:
    return bool(_compile(pattern).fullmatch(path.replace("\\", "/").strip("/")))


def protected_changes(
    worktree: Path, bases: list[str], patterns: list[str] | tuple[str, ...]
) -> list[str] | None:
    """The protected paths the task changed; None when that cannot be known."""
    if not patterns:
        return []
    paths = changed_paths(worktree, bases)
    if paths is None:
        return None
    return sorted(p for p in paths if any(matches(p, pat) for pat in patterns))
