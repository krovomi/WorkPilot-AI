"""Before a merge, the files another unmerged task also changed are named.

Reading a task's branch used to mark it finished at once, so no task was ever
active and this check never named anything.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from cli.workspace_commands import _detect_parallel_task_conflicts
from merge import MergePreview


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "dev@example.invalid")
    git(root, "config", "user.name", "Dev")
    git(root, "config", "commit.gpgsign", "false")
    (root / "app.py").write_bytes(b"def run():\n    return 1\n")
    (root / "util.py").write_bytes(b"x = 1\n")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "base")
    for task, name in [("001-a", "app.py"), ("002-b", "app.py"), ("003-c", "util.py")]:
        path = root / ".workpilot" / "worktrees" / "tasks" / task
        git(root, "worktree", "add", "-q", "-b", f"workpilot/{task}", str(path), "main")
        (path / name).write_bytes(
            b"# " + task.encode() + b"\n" + (path / name).read_bytes()
        )
        git(path, "commit", "-qam", task)
        MergePreview(root).evolution_tracker.refresh_from_git(
            task, path, target_branch="main"
        )
    return root


def test_another_unmerged_task_on_the_same_file_is_named(project):
    conflicts = _detect_parallel_task_conflicts(project, "001-a", ["app.py"])

    assert conflicts == [{"file": "app.py", "tasks": ["001-a", "002-b"]}]


def test_a_merged_task_is_no_longer_named(project):
    MergePreview(project).evolution_tracker.mark_task_completed("002-b")

    assert _detect_parallel_task_conflicts(project, "001-a", ["app.py"]) == []


def test_a_task_whose_worktree_is_gone_is_no_longer_named(project):
    git(project, "worktree", "remove", "--force", ".workpilot/worktrees/tasks/002-b")

    assert _detect_parallel_task_conflicts(project, "001-a", ["app.py"]) == []


def test_reading_a_merged_task_again_makes_it_active_again(project):
    tracker = MergePreview(project).evolution_tracker
    tracker.mark_task_completed("002-b")
    path = project / ".workpilot" / "worktrees" / "tasks" / "002-b"
    tracker.refresh_from_git("002-b", path, target_branch="main")

    assert _detect_parallel_task_conflicts(project, "001-a", ["app.py"]) == [
        {"file": "app.py", "tasks": ["001-a", "002-b"]}
    ]


def test_the_merge_event_marks_the_task_merged(project, monkeypatch):
    from core import merge_event

    assert "merge.preview:on_merge" in merge_event.SUBSCRIBERS
    monkeypatch.setattr(merge_event, "SUBSCRIBERS", ["merge.preview:on_merge"])

    merge_event.publish(merge_event.MergeEvent(project, "002-b"))

    assert _detect_parallel_task_conflicts(project, "001-a", ["app.py"]) == []
