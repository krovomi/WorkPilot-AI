"""The files of a git ref, as the build would see them when it starts.

A real build runs in a worktree created from a base ref, so the uncommitted
changes of the user's checkout are not part of it. The rehearsal reads the same
tree with ``git ls-tree`` instead of checking out a second worktree: nothing is
written to disk and nothing has to be cleaned up when the run is cancelled.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

# A ref is passed to git as an argument, never through a shell, but an option
# disguised as a ref (``--output=...``) would still be read as one.
_SAFE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,199}$")


class SnapshotError(RuntimeError):
    """The ref cannot be read (not a repository, unknown ref, git missing)."""


@dataclass
class Snapshot:
    """The paths of a tree, plus what the walk adds and removes on top of it."""

    ref: str
    files: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.directories: set[str] = set()
        for path in self.files:
            self._add_parents(path)

    def _add_parents(self, path: str) -> None:
        for parent in PurePosixPath(path).parents:
            text = str(parent)
            if text != ".":
                self.directories.add(text)

    def exists(self, path: str) -> bool:
        return path in self.files

    def add(self, path: str) -> None:
        self.files.add(path)
        self._add_parents(path)

    def is_directory(self, path: str) -> bool:
        return path in self.directories


def read_snapshot(project_path: Path, ref: str = "HEAD") -> Snapshot:
    """The files tracked at ``ref`` in ``project_path``."""
    if not _SAFE_REF.match(ref):
        raise SnapshotError(f"Not a git ref: {ref!r}")
    try:
        result = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "-z", ref],
            cwd=str(project_path),
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SnapshotError(f"git ls-tree failed: {exc}") from exc
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise SnapshotError(f"git ls-tree {ref} failed: {message}")
    names = result.stdout.decode("utf-8", "replace").split("\0")
    return Snapshot(ref=ref, files={name for name in names if name})


def normalise_plan_path(raw: str) -> str | None:
    """A plan path as a repo-relative POSIX path, or ``None`` if it leaves the repo.

    Plans are written by a model: a path may use backslashes, start with ``./``,
    be absolute or climb out with ``..``. Only the first two are repaired; the
    others name a file outside the project, which the build must not touch.
    """
    text = raw.strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    if not text or text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        return None
    parts = PurePosixPath(text).parts
    if any(part == ".." for part in parts):
        return None
    return str(PurePosixPath(*parts))
