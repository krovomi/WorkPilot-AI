"""A real project with a task worktree, the layout WorkPilot builds in."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

TASK = "001-add-login"


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture
def task_project(tmp_path: Path) -> tuple[Path, Path, Path]:
    """(project, worktree, spec_dir) with one commit and a task worktree."""
    project = tmp_path / "project"
    project.mkdir()
    git(project, "init", "-q", "-b", "main")
    git(project, "config", "user.email", "dev@example.invalid")
    git(project, "config", "user.name", "Dev")
    git(project, "config", "commit.gpgsign", "false")
    (project / ".gitignore").write_text(
        ".workpilot/\nnode_modules/\nbin/\n", encoding="utf-8"
    )
    (project / "src").mkdir()
    (project / "src" / "app.py").write_text("print('v1')\n", encoding="utf-8")
    (project / "README.md").write_text("# demo\n", encoding="utf-8")
    git(project, "add", "-A")
    git(project, "commit", "-q", "-m", "init")

    worktree = project / ".workpilot" / "worktrees" / "tasks" / TASK
    git(project, "worktree", "add", "-q", "-b", f"workpilot/{TASK}", str(worktree))
    spec_dir = worktree / ".workpilot" / "specs" / TASK
    spec_dir.mkdir(parents=True)
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    return project, worktree, spec_dir
