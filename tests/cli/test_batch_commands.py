"""`--batch-create`, `--batch-status`, `--batch-cleanup`."""

from __future__ import annotations

import json
import subprocess

import pytest
from cli import batch_commands as bc


def _specs(project):
    return project / ".workpilot" / "specs"


def _batch(tmp_path, data):
    path = tmp_path / "batch.json"
    path.write_text(json.dumps(data) if not isinstance(data, str) else data, "utf-8")
    return str(path)


def test_each_task_becomes_a_numbered_spec(tmp_path, capsys):
    project = tmp_path / "p"
    (_specs(project) / "007-old").mkdir(parents=True)
    (_specs(project) / "notes").mkdir()
    batch = _batch(
        tmp_path,
        {
            "tasks": [
                {
                    "title": "Add login",
                    "description": "A login form",
                    "services": ["backend"],
                    "priority": 2,
                },
                {"title": "Fix: crash on ../../etc/passwd & Ünïcode"},
                {},
            ]
        },
    )

    assert bc.handle_batch_create_command(batch, str(project)) is True

    names = sorted(d.name for d in _specs(project).iterdir())
    assert names == [
        "007-old",
        "008-add-login",
        "009-fix-crash-on-etc-passwd-unicode",
        "010-task-3",
        "notes",
    ]
    req = json.loads(
        (_specs(project) / "008-add-login" / "requirements.json").read_text("utf-8")
    )
    assert req["task_description"] == "A login form"
    assert req["services_involved"] == ["backend"]
    assert req["priority"] == 2
    assert req["workflow_type"] == "feature"
    later = json.loads(
        (_specs(project) / "010-task-3" / "requirements.json").read_text("utf-8")
    )
    assert later["task_description"] == "Task 3"
    out = capsys.readouterr().out
    assert "Created 3 spec(s) successfully" in out
    assert not (tmp_path / "etc").exists()


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "Batch file not found"),
        ("{not json", "Invalid JSON in batch file"),
        ({"tasks": []}, "No tasks found in batch file"),
    ],
)
def test_a_batch_file_that_creates_nothing(tmp_path, capsys, content, message):
    path = str(tmp_path / "none.json") if content is None else _batch(tmp_path, content)
    assert bc.handle_batch_create_command(path, str(tmp_path)) is False
    assert message in capsys.readouterr().out


def _spec(project, name, *files, approved=None):
    spec = _specs(project) / name
    spec.mkdir(parents=True)
    for rel in files:
        (spec / rel).write_text("x", encoding="utf-8")
    if approved is not None:
        plan = {"phases": [], "qa_signoff": {"status": approved}}
        (spec / "implementation_plan.json").write_text(json.dumps(plan), "utf-8")
    return spec


def test_status_shows_the_furthest_step_of_each_spec(tmp_path, capsys):
    _spec(tmp_path, "001-new")
    _spec(tmp_path, "002-specced", "spec.md")
    _spec(tmp_path, "003-building", "spec.md", "implementation_plan.json")
    _spec(tmp_path, "004-rejected", "spec.md", "qa_report.md", approved="rejected")
    _spec(tmp_path, "005-done", "spec.md", "qa_report.md", approved="approved")
    (_specs(tmp_path) / "001-new" / "requirements.json").write_text(
        json.dumps({"task_description": "Add login"}), "utf-8"
    )
    (_specs(tmp_path) / "002-specced" / "requirements.json").write_text("{", "utf-8")

    assert bc.handle_batch_status_command(str(tmp_path)) is True

    out = capsys.readouterr().out
    assert "Found 5 spec(s)" in out
    lines = [line for line in out.splitlines() if " 00" in line]
    assert [line.split()[0] for line in lines] == ["⏳", "📋", "⚙️", "⚙️", "✅"]
    assert lines[0].rstrip().endswith("Add login")
    assert lines[1].rstrip().endswith("002-specced")


def test_status_without_specs(tmp_path, capsys):
    assert bc.handle_batch_status_command(str(tmp_path)) is True
    assert "No specs found in project" in capsys.readouterr().out
    _specs(tmp_path).mkdir(parents=True)
    assert bc.handle_batch_status_command(str(tmp_path)) is True
    assert "No specs found" in capsys.readouterr().out


def _worktree(repo, name):
    path = repo / ".workpilot" / "worktrees" / "tasks" / name
    subprocess.run(
        ["git", "worktree", "add", "-b", f"workpilot/{name}", str(path)],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    return path


@pytest.fixture
def repo(temp_git_repo):
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", "init"],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
    )
    return temp_git_repo


def test_cleanup_dry_run_lists_only_approved_specs(repo, capsys):
    _spec(repo, "001-done", "qa_report.md", approved="approved")
    _spec(repo, "002-rejected", "qa_report.md", approved="rejected")
    _worktree(repo, "001-done")

    assert bc.handle_batch_cleanup_command(str(repo)) is True

    out = capsys.readouterr().out
    assert "Found 1 completed spec(s)" in out
    assert "  - 001-done\n    └─ .workpilot/worktrees/tasks/001-done/" in out
    assert "002-rejected" not in out
    assert (_specs(repo) / "001-done").is_dir()


def test_cleanup_removes_approved_specs_and_their_worktrees(repo, capsys):
    """A rejected build also has a QA report: it is work in progress, and
    cleaning up used to delete it with the finished ones."""
    _spec(repo, "001-done", "qa_report.md", approved="approved")
    _spec(repo, "002-rejected", "qa_report.md", approved="rejected")
    _spec(repo, "003-no-tree", approved="approved")
    tree = _worktree(repo, "001-done")
    _worktree(repo, "002-rejected")

    assert bc.handle_batch_cleanup_command(str(repo), dry_run=False) is True

    assert sorted(d.name for d in _specs(repo).iterdir()) == ["002-rejected"]
    assert not tree.exists()
    assert (repo / ".workpilot/worktrees/tasks/002-rejected").is_dir()
    listed = subprocess.run(
        ["git", "worktree", "list"], cwd=repo, capture_output=True, text=True
    ).stdout
    assert "001-done" not in listed
    out = capsys.readouterr().out
    assert "Removed worktree: 001-done" in out
    assert "Cleaned up 2 spec(s)" in out


def test_a_folder_git_does_not_know_is_removed_by_hand(tmp_path, capsys):
    _spec(tmp_path, "001-done", approved="approved")
    stray = tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-done"
    stray.mkdir(parents=True)
    (stray / "f.txt").write_text("x", encoding="utf-8")

    bc.handle_batch_cleanup_command(str(tmp_path), dry_run=False)

    assert not stray.exists()
    assert "Removed worktree directory: 001-done" in capsys.readouterr().out


def test_a_git_that_hangs_or_is_missing(tmp_path, monkeypatch, capsys):
    for name in ("001-slow", "002-nogit"):
        _spec(tmp_path, name, approved="approved")
        (tmp_path / ".workpilot" / "worktrees" / "tasks" / name).mkdir(parents=True)

    def git(cmd, **kwargs):
        if cmd[-1].endswith("001-slow"):
            raise subprocess.TimeoutExpired(cmd, 30)
        raise FileNotFoundError("git")

    monkeypatch.setattr(bc.subprocess, "run", git)

    bc.handle_batch_cleanup_command(str(tmp_path), dry_run=False)

    out = capsys.readouterr().out
    assert "timed out, removed directory: 001-slow" in out
    assert "Failed to remove worktree 002-nogit" in out
    assert "Cleaned up 2 spec(s)" in out


def test_a_spec_that_cannot_be_removed(tmp_path, monkeypatch, capsys):
    _spec(tmp_path, "001-done", approved="approved")

    def refuse(path, *args, **kwargs):
        raise PermissionError(path)

    monkeypatch.setattr(bc.shutil, "rmtree", refuse)
    bc.handle_batch_cleanup_command(str(tmp_path), dry_run=False)
    out = capsys.readouterr().out
    assert "Failed to remove spec 001-done" in out
    assert "Cleaned up 0 spec(s)" in out


def test_cleanup_with_nothing_to_clean(tmp_path, capsys):
    assert bc.handle_batch_cleanup_command(str(tmp_path)) is True
    assert "No specs directory found" in capsys.readouterr().out
    _spec(tmp_path, "001-wip", "spec.md")
    assert bc.handle_batch_cleanup_command(str(tmp_path)) is True
    assert "No completed specs to clean up" in capsys.readouterr().out
