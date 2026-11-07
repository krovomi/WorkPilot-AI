"""A throwaway copy of the task's code, where the mutants run.

Never the task's worktree: a mutant left behind by a crash would be shipped.
The copy is a detached ``git worktree`` of the task's HEAD, with the changes
not committed yet applied on top and the untracked files copied, so it holds
exactly what QA reviewed. The dependency folders git ignores
(``node_modules``, ``.venv``, ``vendor``) are linked, not installed: the copy
runs offline, as the task's worktree does. The copy is removed in a
``finally``, links first so nothing behind them is touched.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

from foundation.git_executable import run_git
from foundation.platform import is_windows

__all__ = ["DEPENDENCY_DIRS", "scratch_copy"]

DEPENDENCY_DIRS = ("node_modules", ".venv", "venv", "vendor")
_MAX_DEPTH = 3


def _link_dir(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError:
        if not is_windows():
            raise
        import _winapi  # type: ignore[import-not-found]  # Windows leg

        # A junction needs no privilege, unlike a symbolic link.
        _winapi.CreateJunction(str(target), str(link))


def _unlink_dir(link: Path) -> None:
    """Remove the link itself, never what it points to."""
    with contextlib.suppress(OSError):
        if link.is_symlink():
            link.unlink()
        else:
            os.rmdir(link)  # a junction is removed like an empty folder


def _dependency_dirs(project_dir: Path) -> list[Path]:
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False) and not entry.is_symlink():
                continue
            if entry.name in DEPENDENCY_DIRS:
                found.append(Path(entry.path))
            elif (
                depth < _MAX_DEPTH
                and not entry.name.startswith(".")
                and not entry.is_symlink()
            ):
                walk(Path(entry.path), depth + 1)

    walk(project_dir, 0)
    return found


def _copy_untracked(project_dir: Path, copy: Path) -> None:
    listed = run_git(
        ["ls-files", "--others", "--exclude-standard", "-z"], cwd=project_dir
    )
    for name in listed.stdout.split("\0") if listed.returncode == 0 else []:
        if not name or "__pycache__" in name.split("/"):
            continue
        source = project_dir / name
        if source.is_symlink() or not source.is_file():
            continue
        dest = copy / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)


@contextlib.contextmanager
def scratch_copy(project_dir: Path, *, timeout: int = 300) -> Iterator[Path]:
    """A detached copy of ``project_dir`` as QA saw it; removed on exit.

    Raises ``OSError`` when the copy cannot be made.
    """
    project_dir = Path(project_dir).resolve()
    holder = Path(tempfile.mkdtemp(prefix="workpilot-mutation-"))
    copy = holder / "copy"
    links: list[Path] = []
    added = False
    try:
        made = run_git(
            ["worktree", "add", "--detach", str(copy), "HEAD"],
            cwd=project_dir,
            timeout=timeout,
        )
        if made.returncode != 0:
            raise OSError(f"git worktree add failed: {made.stderr.strip()[:200]}")
        added = True
        pending = run_git(
            ["diff", "--binary", "HEAD"], cwd=project_dir, timeout=timeout
        )
        if pending.returncode != 0:
            raise OSError("git diff failed")
        if pending.stdout.strip():
            applied = run_git(
                ["apply", "--whitespace=nowarn", "-"],
                cwd=copy,
                input_data=pending.stdout,
                timeout=timeout,
            )
            if applied.returncode != 0:
                raise OSError(f"git apply failed: {applied.stderr.strip()[:200]}")
        _copy_untracked(project_dir, copy)
        for source in _dependency_dirs(project_dir):
            link = copy / source.relative_to(project_dir)
            if link.exists() or link.is_symlink() or not link.parent.is_dir():
                continue
            _link_dir(source.resolve(), link)
            links.append(link)
        yield copy
    finally:
        for link in links:
            _unlink_dir(link)
        if added:
            run_git(["worktree", "remove", "--force", str(copy)], cwd=project_dir)
        shutil.rmtree(holder, ignore_errors=True)
        run_git(["worktree", "prune"], cwd=project_dir)
