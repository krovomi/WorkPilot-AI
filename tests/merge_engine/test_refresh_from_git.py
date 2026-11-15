"""What a task changed, read from its branch in git.

The merge preview reads it before every merge, so one file git names
strangely, or one file that is not UTF-8, must not hide the others.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from merge.file_evolution import FileEvolutionTracker


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout


@pytest.fixture
def repo(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    git(project, "init", "-q", "-b", "main")
    git(project, "config", "user.email", "dev@example.invalid")
    git(project, "config", "user.name", "Dev")
    git(project, "config", "commit.gpgsign", "false")
    (project / "app.py").write_bytes(b"def run():\n    return 1\n")
    (project / "gone.py").write_bytes(b"x = 1\n")
    git(project, "add", ".")
    git(project, "commit", "-q", "-m", "base")
    git(project, "checkout", "-q", "-b", "task")
    return project


def commit_task(project: Path) -> None:
    git(project, "add", "-A")
    git(project, "commit", "-q", "-m", "task")


def refresh(project: Path, **kwargs):
    tracker = FileEvolutionTracker(project, storage_dir=project / ".wp")
    tracker.refresh_from_git("001-task", project, **kwargs)
    return tracker


def test_each_changed_file_is_recorded_with_its_content_before(repo):
    (repo / "app.py").write_bytes(b"import os\n\ndef run():\n    return 2\n")
    (repo / "added.py").write_bytes(b"y = 2\n")
    (repo / "gone.py").unlink()
    commit_task(repo)

    tracker = refresh(repo, target_branch="main")

    assert set(tracker.get_files_modified_by_tasks(["001-task"])) == {
        "app.py",
        "added.py",
        "gone.py",
    }
    app = tracker.get_file_evolution("app.py").get_task_snapshot("001-task")
    assert "+import os" in app.raw_diff
    assert [c.change_type.value for c in app.semantic_changes] == ["add_import"]


def test_a_file_name_git_would_quote_is_read(repo):
    (repo / "café.py").write_bytes(b"value = 'caf\xc3\xa9'\n")
    commit_task(repo)

    tracker = refresh(repo, target_branch="main")

    snapshot = tracker.get_file_evolution("café.py").get_task_snapshot("001-task")
    assert snapshot is not None
    assert "+value = 'café'" in snapshot.raw_diff


def test_a_file_that_is_not_utf8_does_not_hide_the_others(repo):
    (repo / "legacy.txt").write_bytes(b"r\xe9sum\xe9\n")  # Latin-1
    (repo / "app.py").write_bytes(b"def run():\n    return 3\n")
    commit_task(repo)

    tracker = refresh(repo, target_branch="main")

    assert set(tracker.get_files_modified_by_tasks(["001-task"])) == {
        "legacy.txt",
        "app.py",
    }


def test_only_named_files_get_a_semantic_analysis(repo):
    (repo / "app.py").write_bytes(b"import os\n\ndef run():\n    return 1\n")
    (repo / "added.py").write_bytes(b"import sys\n")
    commit_task(repo)

    tracker = refresh(repo, target_branch="main", analyze_only_files={"app.py"})

    app = tracker.get_file_evolution("app.py").get_task_snapshot("001-task")
    added = tracker.get_file_evolution("added.py").get_task_snapshot("001-task")
    assert app.semantic_changes and not added.semantic_changes
    assert "+import sys" in added.raw_diff


@pytest.mark.parametrize("base", ["main", "develop"])
def test_the_branch_the_task_left_is_found(tmp_path, base):
    project = tmp_path / "p"
    project.mkdir()
    git(project, "init", "-q", "-b", base)
    git(project, "config", "user.email", "dev@example.invalid")
    git(project, "config", "user.name", "Dev")
    git(project, "config", "commit.gpgsign", "false")
    (project / "a.py").write_bytes(b"a = 1\n")
    git(project, "add", ".")
    git(project, "commit", "-q", "-m", "base")
    git(project, "checkout", "-q", "-b", "task")
    (project / "a.py").write_bytes(b"a = 2\n")
    commit_task(project)

    tracker = refresh(project)

    assert tracker.get_files_modified_by_tasks(["001-task"]) == {"a.py": ["001-task"]}


def test_an_unknown_branch_records_nothing(repo):
    (repo / "app.py").write_bytes(b"def run():\n    return 9\n")
    commit_task(repo)

    tracker = refresh(repo, target_branch="no-such-branch")

    assert tracker.get_files_modified_by_tasks(["001-task"]) == {}


def test_a_save_that_fails_halfway_keeps_the_previous_record(repo, monkeypatch):
    (repo / "app.py").write_bytes(b"def run():\n    return 4\n")
    commit_task(repo)
    tracker = refresh(repo, target_branch="main")
    saved = tracker.storage.evolution_file.read_text(encoding="utf-8")

    from merge.types import FileEvolution

    monkeypatch.setattr(FileEvolution, "to_dict", lambda self: {"broken": {1, 2}})
    tracker.storage.save_evolutions(tracker._evolutions)

    assert tracker.storage.evolution_file.read_text(encoding="utf-8") == saved
    again = FileEvolutionTracker(repo, storage_dir=repo / ".wp")
    assert again.get_files_modified_by_tasks(["001-task"]) == {"app.py": ["001-task"]}


def test_two_tasks_on_one_file_are_what_the_preview_reports(repo):
    other = repo.parent / "other"
    git(repo, "worktree", "add", "-q", "-b", "task2", str(other), "main")
    (repo / "app.py").write_bytes(b"import os\n\ndef run():\n    return 1\n")
    (repo / "added.py").write_bytes(b"y = 2\n")
    commit_task(repo)
    (other / "app.py").write_bytes(b"import sys\n\ndef run():\n    return 1\n")
    commit_task(other)

    tracker = FileEvolutionTracker(repo, storage_dir=repo / ".wp")
    tracker.refresh_from_git("t1", repo, target_branch="main")
    tracker.refresh_from_git("t2", other, target_branch="main")

    assert tracker.get_conflicting_files(["t1", "t2"]) == ["app.py"]
    assert tracker.get_files_modified_by_tasks(["t1", "t2"]) == {
        "app.py": ["t1", "t2"],
        "added.py": ["t1"],
    }
