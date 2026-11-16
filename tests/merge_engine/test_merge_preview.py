"""The preview a merge shows first: what two tasks changed in the same place.

It reads each task's branch from git, then names the conflicts between them.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from merge import MergePreview


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def two_tasks(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    git(project, "init", "-q", "-b", "main")
    git(project, "config", "user.email", "dev@example.invalid")
    git(project, "config", "user.name", "Dev")
    git(project, "config", "commit.gpgsign", "false")
    (project / "app.py").write_bytes(b"import os\n\ndef run():\n    return 1\n")
    (project / "util.py").write_bytes(b"def helper():\n    return 0\n")
    git(project, "add", ".")
    git(project, "commit", "-q", "-m", "base")

    worktrees = {}
    for task, app, util in [
        ("t1", b"import os\n\ndef run():\n    return 2\n", None),
        (
            "t2",
            b"import os\n\ndef run():\n    return 3\n",
            b"def helper():\n    return 9\n",
        ),
    ]:
        path = tmp_path / task
        git(project, "worktree", "add", "-q", "-b", task, str(path), "main")
        (path / "app.py").write_bytes(app)
        if util:
            (path / "util.py").write_bytes(util)
        git(path, "commit", "-qam", task)
        worktrees[task] = path
    return project, worktrees


def test_two_rewrites_of_one_function_are_shown_before_merging(two_tasks):
    project, worktrees = two_tasks
    preview = MergePreview(project)
    for task, path in worktrees.items():
        preview.evolution_tracker.refresh_from_git(task, path, target_branch="main")

    report = preview.preview_merge(["t1", "t2"])

    assert sorted(report["files_to_merge"]) == ["app.py", "util.py"]
    assert report["files_with_potential_conflicts"] == ["app.py"]
    (conflict,) = report["conflicts"]
    assert conflict["file"] == "app.py"
    assert conflict["location"] == "function:run"
    assert conflict["tasks"] == ["t1", "t2"]
    assert conflict["can_auto_merge"] is False
    assert conflict["strategy"] == "ai_required"
    assert report["summary"] == {
        "total_files": 2,
        "conflict_files": 1,
        "total_conflicts": 1,
        "auto_mergeable": 0,
    }


def test_one_task_alone_has_nothing_to_show(two_tasks):
    project, worktrees = two_tasks
    preview = MergePreview(project)
    preview.evolution_tracker.refresh_from_git(
        "t1", worktrees["t1"], target_branch="main"
    )

    report = preview.preview_merge(["t1"])

    assert report["files_to_merge"] == ["app.py"]
    assert report["conflicts"] == []
    assert report["summary"]["total_conflicts"] == 0


def test_the_record_lives_in_the_project_workpilot_folder(two_tasks):
    project, worktrees = two_tasks
    preview = MergePreview(project)
    preview.evolution_tracker.refresh_from_git(
        "t1", worktrees["t1"], target_branch="main"
    )

    assert (project / ".workpilot" / "file_evolution.json").is_file()
    assert MergePreview(project).evolution_tracker.get_files_modified_by_tasks(
        ["t1"]
    ) == {"app.py": ["t1"]}
