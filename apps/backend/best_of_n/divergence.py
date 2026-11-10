"""How far apart the variants' approaches are, and what each one changed.

Two variants that pass the same checks can still be two different designs: one
puts the logic in a service, the other in the controller. The ranking cannot
see that; the content of the files can. For each pair of built variants, the
divergence is one minus the similarity of the files either of them changed,
weighted by size: the same final file on both sides counts 0, a file only one
of them wrote counts 1.

When the variants worth keeping (built, every subtask done) diverge by at
least the threshold, or none of them ranks first alone, the arbiter is asked
for a verdict. Below it they are the same answer written twice, and the
ranking is enough.

Reads git and files only; writes nothing.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path

from foundation.git_executable import get_git_executable

__all__ = ["DEFAULT_THRESHOLD", "Changes", "changes", "divergence", "threshold"]

DEFAULT_THRESHOLD = 0.3
MAX_FILES = 200
MAX_FILE_BYTES = 200_000
MAX_LINES = 4_000


def threshold() -> float:
    """``WORKPILOT_ARBITER_DIVERGENCE`` (0 to 1), 0.3 by default."""
    raw = os.environ.get("WORKPILOT_ARBITER_DIVERGENCE", "")
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_THRESHOLD
    return value if 0.0 <= value <= 1.0 else DEFAULT_THRESHOLD


@dataclass
class Changes:
    """What one variant changed against its fork point."""

    files: dict[str, str | None] = field(default_factory=dict)
    """Path → the file's final text (None when deleted or unreadable as text)."""
    patch: str = ""
    """The unified diff, for the arbiter to read (capped by the caller)."""
    tests: list[str] = field(default_factory=list)
    readable: bool = True


def _git(cwd: Path, *args: str) -> tuple[int, str]:
    try:
        done = subprocess.run(  # noqa: S603 - fixed argv
            [get_git_executable(), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return done.returncode, done.stdout


_TEST_PARTS = (
    "test",
    "tests",
    "spec",
    "specs",
    "__tests__",
    "e2e",
    "integrationtests",
    "unittests",
)
_TEST_SUFFIXES = (
    "_test.go",
    "_test.py",
    "_spec.rb",
    "test.java",
    "tests.java",
    "test.kt",
    "tests.cs",
    "test.cs",
    "tests.swift",
    "_test.dart",
    "test.php",
    ".test.ts",
    ".test.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.ts",
    ".spec.tsx",
    ".spec.js",
    ".spec.jsx",
    "_test.rs",
    "_test.exs",
)


def is_test_path(path: str) -> bool:
    """A test file by the conventions of the common stacks (folders and names)."""
    lower = path.replace("\\", "/").lower()
    name = lower.rsplit("/", 1)[-1]
    if name.startswith("test_") or name.endswith(_TEST_SUFFIXES):
        return True
    parts = lower.split("/")[:-1]
    return any(
        part in _TEST_PARTS or part.endswith((".tests", ".test")) for part in parts
    )


def _text(file: Path) -> str | None:
    try:
        if (
            file.is_symlink()
            or not file.is_file()
            or file.stat().st_size > MAX_FILE_BYTES
        ):
            return None
        data = file.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", errors="replace")


def changes(worktree: Path, bases: list[str]) -> Changes:
    """The files a variant changed since the first fork point git knows."""
    for base in bases:
        code, names = _git(
            worktree,
            "diff",
            "--name-only",
            "--no-renames",
            base,
            "--",
            ".",
            ":(exclude).workpilot",
        )
        if code != 0:
            continue
        _, untracked = _git(
            worktree,
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            ".",
            ":(exclude).workpilot",
        )
        paths = sorted(
            {p for p in (names + "\n" + untracked).splitlines() if p.strip()}
        )[:MAX_FILES]
        _, patch = _git(
            worktree,
            "diff",
            "--no-renames",
            "--unified=3",
            base,
            "--",
            ".",
            ":(exclude).workpilot",
        )
        found = Changes(patch=patch)
        for relative in paths:
            target = (worktree / relative).resolve()
            inside = target.is_relative_to(worktree.resolve())
            found.files[relative] = _text(target) if inside else None
            if is_test_path(relative):
                found.tests.append(relative)
        return found
    return Changes(readable=False)


def _similarity(a: str | None, b: str | None) -> float:
    if a is None and b is None:
        return 1.0
    if a is None or b is None:
        return 0.0
    if a == b:
        return 1.0
    left, right = a.splitlines()[:MAX_LINES], b.splitlines()[:MAX_LINES]
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def pair_divergence(a: Changes, b: Changes) -> float:
    """0 when both changed the same files to the same text, 1 when nothing is shared."""
    paths = set(a.files) | set(b.files)
    if not paths:
        return 0.0
    weighted = total = 0.0
    for path in paths:
        left, right = a.files.get(path), b.files.get(path)
        if path not in a.files or path not in b.files:
            similarity = 0.0
        else:
            similarity = _similarity(left, right)
        weight = max(len((left or "").splitlines()), len((right or "").splitlines()), 1)
        weighted += (1.0 - similarity) * weight
        total += weight
    return round(weighted / total, 3)


def divergence(
    candidates: dict[str, Changes], recommended: str | None, limit: float
) -> dict:
    """Whether the arbiter is needed, with each pair's divergence and the reason.

    ``candidates`` are the variants worth keeping, by spec id. Fewer than two:
    nothing to arbitrate. A change set git could not read: no verdict either,
    since its divergence would be a guess.
    """
    ids = sorted(candidates)
    if len(ids) < 2:
        return {
            "needed": False,
            "reason": "single_candidate",
            "pairs": [],
            "max": 0.0,
            "threshold": limit,
        }
    if any(not candidates[i].readable for i in ids):
        return {
            "needed": False,
            "reason": "changes_unknown",
            "pairs": [],
            "max": 0.0,
            "threshold": limit,
        }
    pairs = [
        {"a": a, "b": b, "divergence": pair_divergence(candidates[a], candidates[b])}
        for a, b in combinations(ids, 2)
    ]
    highest = max(p["divergence"] for p in pairs)
    if highest >= limit:
        reason = "diverge"
    elif recommended is None:
        reason = "no_winner"
    else:
        reason = "same_approach"
    return {
        "needed": reason != "same_approach",
        "reason": reason,
        "pairs": pairs,
        "max": highest,
        "threshold": limit,
    }
