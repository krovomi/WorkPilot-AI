"""How much of a change a person has to read: lines weighed by file kind.

A ceiling of changed lines treats a lockfile like the payment service. What
tires a reviewer is the code they must understand, so a changed line counts
by the kind of file it is in, decided from the path alone (every stack):

- code: 1;
- tests and documentation: 0.5 (read faster, and checked against the code
  next to them; this weight is a judgment call, no study measures it);
- generated, vendored, lockfiles and test snapshots: 0 (a tool wrote them);
- a deleted line: a quarter of its kind's weight, and a whole deleted file
  counts as one line (Google's code review guide counts it the same way).

Pure: no I/O.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

from foundation.change_scope import is_generated_path, is_text_only_path
from foundation.test_conventions import is_test, is_test_dir

__all__ = [
    "CODE",
    "DELETED_WEIGHT",
    "DOCS",
    "GENERATED",
    "TEST",
    "WEIGHTS",
    "changed_lines_load",
    "file_kind",
    "file_weight",
]

CODE = "code"
TEST = "test"
DOCS = "docs"
GENERATED = "generated"

WEIGHTS: dict[str, float] = {CODE: 1.0, TEST: 0.5, DOCS: 0.5, GENERATED: 0.0}

#: A deleted line costs a quarter of an added one: the reviewer checks it is
#: unused, not what it does.
DELETED_WEIGHT = 0.25

#: Lockfiles of every package manager WorkPilot meets: written by the tool,
#: reviewed through the manifest next to them.
_LOCKFILES = frozenset(
    {
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "bun.lock",
        "deno.lock",
        "poetry.lock",
        "pipfile.lock",
        "uv.lock",
        "pdm.lock",
        "cargo.lock",
        "go.sum",
        "composer.lock",
        "gemfile.lock",
        "packages.lock.json",
        "paket.lock",
        "podfile.lock",
        "package.resolved",
        "pubspec.lock",
        "mix.lock",
        "gradle.lockfile",
        "flake.lock",
        "conan.lock",
        "vcpkg-lock.json",
    }
)

#: Snapshot and approval files written by the test runner (Jest, Vitest,
#: syrupy, Verify for .NET, ApprovalTests, insta for Rust).
_SNAPSHOT_DIRS = frozenset({"__snapshots__", "__snapshot__"})
_SNAPSHOT_SUFFIXES = (".snap", ".ambr", ".snap.new")
_SNAPSHOT_INFIXES = (".verified.", ".approved.", ".received.")


#: Test names that ``test_conventions`` leaves to ``touched_tests``: the
#: JavaScript and TypeScript families (``cart.spec.ts``, ``a.test.tsx``,
#: ``login.e2e.ts``, ``home.cy.js``) and Python's ``test_x.py`` / ``x_test.py``.
_TEST_STEM = re.compile(r"(^test_|_test$|[._-](test|tests|spec|e2e|cy)$)")


def _path(path: str) -> PurePosixPath:
    return PurePosixPath(str(path).replace("\\", "/"))


def file_kind(path: str) -> str:
    """``code``, ``test``, ``docs`` or ``generated`` for ``path``."""
    p = _path(path)
    name = p.name.lower()
    dirs = [part for part in p.parts[:-1]]
    if (
        name in _LOCKFILES
        or name.endswith(".lock")
        or is_generated_path(str(p))
        or name.endswith(_SNAPSHOT_SUFFIXES)
        or any(infix in name for infix in _SNAPSHOT_INFIXES)
        or any(d.lower() in _SNAPSHOT_DIRS for d in dirs)
    ):
        return GENERATED
    if is_text_only_path(str(p)) or any(d.lower() == "docs" for d in dirs[:1]):
        return DOCS
    stem = name.rsplit(".", 1)[0] if "." in name else name
    if is_test(p) or _TEST_STEM.search(stem) or any(is_test_dir(d) for d in dirs):
        return TEST
    return CODE


def file_weight(path: str) -> float:
    """What one changed line of ``path`` costs a reviewer."""
    return WEIGHTS[file_kind(path)]


def changed_lines_load(
    path: str, added: int, deleted: int, *, file_deleted: bool = False
) -> float:
    """The lines to review for one file of a diff."""
    weight = file_weight(path)
    if file_deleted:
        return min(1.0, weight) if weight else 0.0
    return weight * max(0, added) + weight * DELETED_WEIGHT * max(0, deleted)
