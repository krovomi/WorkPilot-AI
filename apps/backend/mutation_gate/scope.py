"""Which lines the gate mutates: those the task added or changed, from git.

The diff is the task's against its base (the merge base the QA review uses),
working tree included: what the fixer wrote and did not commit yet counts.
Only source files are kept: a test file is what the mutants test, and a file
in a language the mutator does not read has nothing to invert.
"""

from __future__ import annotations

import re
from pathlib import Path

from foundation.git_executable import run_git
from foundation.touched_tests import is_test_file as _named_test

from .mutator import language_of

__all__ = ["changed_lines", "is_test_path"]

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
#: A generated or vendored file is no one's test target.
_IGNORED_DIRS = frozenset(
    {"node_modules", "vendor", "dist", "build", "target", "bin", "obj", ".git"}
)


def is_test_path(path: str) -> bool:
    """A test by its stack's naming convention, or inside a test directory."""
    from foundation.test_conventions import is_test_dir

    normalised = path.replace("\\", "/")
    parts = normalised.split("/")
    return _named_test(normalised) or any(is_test_dir(p) for p in parts[:-1])


def _wanted(path: str) -> bool:
    parts = path.replace("\\", "/").split("/")
    return (
        language_of(path) is not None
        and not is_test_path(path)
        and not any(p in _IGNORED_DIRS for p in parts[:-1])
    )


def _added(diff: str) -> dict[str, set[int]]:
    lines: dict[str, set[int]] = {}
    path: str | None = None
    for row in diff.splitlines():
        if row.startswith("+++ "):
            target = row[4:].strip()
            path = target[2:] if target.startswith("b/") else None
            continue
        match = _HUNK.match(row)
        if match and path:
            start = int(match.group(1))
            count = 1 if match.group(2) is None else int(match.group(2))
            lines.setdefault(path, set()).update(range(start, start + count))
    return {p: s for p, s in lines.items() if s}


def changed_lines(
    project_dir: Path, base: str, files: list[str]
) -> dict[str, set[int]]:
    """``{path: {line, …}}``: the new-side lines the task wrote, per source file.

    Raises ``OSError`` when git cannot answer: the caller reports "unknown".
    """
    wanted = sorted({f for f in files if _wanted(f)})
    if not wanted:
        return {}
    diff = run_git(
        ["diff", "--no-color", "--no-ext-diff", "-U0", base, "--", *wanted],
        cwd=project_dir,
    )
    if diff.returncode != 0:
        raise OSError(f"git diff failed: {diff.stderr.strip()[:200]}")
    result = _added(diff.stdout)
    untracked = run_git(
        ["ls-files", "--others", "--exclude-standard", "--", *wanted], cwd=project_dir
    )
    for path in untracked.stdout.splitlines() if untracked.returncode == 0 else []:
        try:
            text = (Path(project_dir) / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        result[path] = set(range(1, text.count("\n") + 2))
    return result
