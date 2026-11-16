"""When the last commit is probably not the culprit (#375).

The CI/CD mode used to read only ``sha~1..sha``. These deterministic signals,
read from git, say that the regression likely came from further back and that
a bisect is worth its test runs:

``trivial_diff``        the last commit changed fewer than :data:`TRIVIAL_LINES`
                        lines, yet tests fail;
``old_test``            a failing test's file was not touched in the
                        :data:`OLD_TEST_DAYS` days before the failing commit;
``dependency_changed``  a manifest or lockfile of any stack changed between
                        the last green commit and the failing one.

A flaky test is the opposite signal; the bisect checks for it itself (the
failing commit is run several times before any search).
"""

from __future__ import annotations

import logging
import re
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "DEPENDENCY_FILES",
    "OLD_TEST_DAYS",
    "TRIVIAL_LINES",
    "BisectTriggers",
    "evaluate_triggers",
    "is_commit_sha",
    "failing_test_files",
]

TRIVIAL_LINES = 10
OLD_TEST_DAYS = 30
_TIMEOUT = 30
_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")

#: Manifests and lockfiles, by file name, of every stack the product supports.
DEPENDENCY_FILES = frozenset(
    {
        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
        "bun.lock", "bun.lockb", "deno.lock", "deno.json",
        "requirements.txt", "requirements-dev.txt", "pyproject.toml", "poetry.lock",
        "uv.lock", "Pipfile", "Pipfile.lock", "setup.py", "setup.cfg",
        "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
        "Gemfile", "Gemfile.lock", "composer.json", "composer.lock",
        "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile",
        "libs.versions.toml", "packages.config", "packages.lock.json",
        "Directory.Packages.props", "Directory.Build.props", "global.json",
        "mix.exs", "mix.lock", "pubspec.yaml", "pubspec.lock",
        "Package.swift", "Package.resolved", "Podfile", "Podfile.lock",
    }
)  # fmt: skip
_DEPENDENCY_SUFFIXES = (".csproj", ".fsproj", ".vbproj")


def is_commit_sha(value: object) -> bool:
    """A hexadecimal commit id, short or full: the only form a bisect accepts."""
    return isinstance(value, str) and bool(_SHA.fullmatch(value))


def is_dependency_file(path: str) -> bool:
    name = PurePosixPath(path.replace("\\", "/")).name
    return name in DEPENDENCY_FILES or name.endswith(_DEPENDENCY_SUFFIXES)


def git(
    project_dir: Path, args: Sequence[str], timeout: float = _TIMEOUT
) -> str | None:
    """stdout of ``git args`` in ``project_dir``, ``None`` on any failure."""
    try:
        result = subprocess.run(  # noqa: S603 - argv list, no shell
            ["git", *args],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("git %s failed: %s", list(args[:1]), exc)
        return None
    return result.stdout if result.returncode == 0 else None


def failing_test_files(project_dir: Path, failing_tests: Sequence[str]) -> list[str]:
    """The repository files the failing test names point at, when they do.

    ``tests/test_auth.py::test_login``, ``src/a.test.ts > renders``,
    ``spec/user_spec.rb:12``: the part before the test's own name, when it is
    a file of this repository (resolved inside it, never outside).
    """
    root = project_dir.resolve()
    files: list[str] = []
    for name in failing_tests:
        head = re.split(r"::| > | › |\s|\(", str(name).strip(), maxsplit=1)[0]
        head = re.sub(r":\d+$", "", head).replace("\\", "/")
        if not head or "/" not in head and "." not in head:
            continue
        try:
            candidate = (root / head).resolve()
            candidate.relative_to(root)
        except (OSError, ValueError):
            continue
        if candidate.is_file():
            rel = candidate.relative_to(root).as_posix()
            if rel not in files:
                files.append(rel)
    return files


@dataclass
class BisectTriggers:
    trivial_diff: bool = False
    changed_lines: int | None = None
    old_tests: list[str] = field(default_factory=list)
    dependency_files: list[str] = field(default_factory=list)

    @property
    def reasons(self) -> list[str]:
        reasons = []
        if self.trivial_diff:
            reasons.append("trivial_diff")
        if self.old_tests:
            reasons.append("old_test")
        if self.dependency_files:
            reasons.append("dependency_changed")
        return reasons

    @property
    def fired(self) -> bool:
        return bool(self.reasons)

    def to_dict(self) -> dict[str, Any]:
        return {
            "fired": self.fired,
            "reasons": self.reasons,
            "changed_lines": self.changed_lines,
            "old_tests": self.old_tests,
            "dependency_files": self.dependency_files,
        }


def _changed_lines(project_dir: Path, bad: str) -> int | None:
    out = git(project_dir, ["diff", "--numstat", f"{bad}~1", bad])
    if out is None:
        return None
    total = 0
    for line in out.splitlines():
        # added, deleted, path; a binary file counts "-" and adds nothing.
        total += sum(int(p) for p in line.split("\t")[:2] if p.isdigit())
    return total


def evaluate_triggers(
    project_dir: str | Path,
    bad: str,
    failing_tests: Sequence[str],
    good: str | None = None,
) -> BisectTriggers:
    """Read the signals for ``bad`` (and the ``good..bad`` range when known)."""
    root = Path(project_dir)
    triggers = BisectTriggers()
    if not is_commit_sha(bad) or (good is not None and not is_commit_sha(good)):
        return triggers
    failing = [t for t in failing_tests if t]

    triggers.changed_lines = _changed_lines(root, bad)
    if failing and triggers.changed_lines is not None:
        triggers.trivial_diff = triggers.changed_lines < TRIVIAL_LINES

    bad_time = (git(root, ["show", "-s", "--format=%ct", bad]) or "").strip()
    if bad_time.isdigit():
        horizon = int(bad_time) - OLD_TEST_DAYS * 86400
        for test_file in failing_test_files(root, failing):
            touched = (
                git(root, ["log", "-1", "--format=%ct", bad, "--", test_file]) or ""
            ).strip()
            if touched.isdigit() and int(touched) < horizon:
                triggers.old_tests.append(test_file)

    if good:
        out = git(root, ["diff", "--name-only", good, bad]) or ""
        triggers.dependency_files = [
            line for line in out.splitlines() if line and is_dependency_file(line)
        ][:20]
    return triggers
