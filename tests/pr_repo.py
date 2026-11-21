"""A real git repository with a local `origin`, for the PR reviewers' worktrees.

The reviewers check a PR's head commit out in a worktree of the project
(`PRWorktreeManager`): `git fetch origin <sha>`, then `git worktree add`.
`make_repo` builds a project whose `origin` is a bare repository next to it,
with git isolated from the caller's configuration.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

__all__ = ["git", "make_repo"]


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def make_repo(tmp_path: Path, monkeypatch, files: dict[str, str]) -> Path:
    """A project at `tmp_path / "project"` with `files` committed and pushed."""
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(var, raising=False)
    for var, value in {
        "GIT_AUTHOR_NAME": "T",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "T",
        "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CEILING_DIRECTORIES": str(tmp_path),
        "GIT_CONFIG_NOSYSTEM": "1",
        "HOME": str(tmp_path),
    }.items():
        monkeypatch.setenv(var, value)
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "--bare", str(origin))
    root = tmp_path / "project"
    root.mkdir()
    git(root, "init", "--initial-branch=main")
    git(root, "remote", "add", "origin", str(origin))
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "first")
    git(root, "push", "origin", "main")
    return root
