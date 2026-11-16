"""Snapshots of a task worktree and the rollback, on a real git repository."""

from __future__ import annotations

from pathlib import Path

import pytest
from agent_snapshots import (
    NAMESPACE,
    SnapshotError,
    create_snapshot,
    list_snapshots,
    rollback,
    task_worktree,
    valid_snapshot_id,
    valid_task_name,
    worktree_of,
)

from .conftest import TASK, git


def test_the_worktree_of_a_task_spec_dir_is_found(task_project):
    project, worktree, spec_dir = task_project
    assert task_worktree(spec_dir) == (worktree.resolve(), TASK)
    # A spec of the main project is not a worktree: no snapshot there.
    main_spec = project / ".workpilot" / "specs" / TASK
    main_spec.mkdir(parents=True)
    assert task_worktree(main_spec) is None


def test_a_snapshot_moves_neither_the_branch_nor_the_index_nor_the_files(task_project):
    _project, worktree, _spec = task_project
    (worktree / "src" / "app.py").write_text("print('v2')\n", encoding="utf-8")
    (worktree / "notes.txt").write_text("draft\n", encoding="utf-8")
    head = git(worktree, "rev-parse", "HEAD")
    status = git(worktree, "status", "--porcelain")

    snapshot = create_snapshot(worktree, TASK, "coding")

    assert git(worktree, "rev-parse", "HEAD") == head
    assert git(worktree, "status", "--porcelain") == status
    assert snapshot.head == head
    assert valid_snapshot_id(snapshot.snapshot_id)
    ref = f"{NAMESPACE}/{TASK}/{snapshot.snapshot_id}"
    files = git(worktree, "ls-tree", "-r", "--name-only", ref).splitlines()
    assert "notes.txt" in files and "src/app.py" in files
    # The build's own state is not the agent's work.
    assert not any(f.startswith(".workpilot") for f in files)
    assert git(worktree, "show", f"{ref}:src/app.py") == "print('v2')"


def test_an_unchanged_worktree_reuses_the_latest_snapshot(task_project):
    _project, worktree, _spec = task_project
    first = create_snapshot(worktree, TASK, "planning")
    second = create_snapshot(worktree, TASK, "coding")
    assert second.snapshot_id == first.snapshot_id
    assert len(list_snapshots(worktree, TASK)) == 1


def test_old_snapshots_are_pruned_beyond_keep(task_project):
    _project, worktree, _spec = task_project
    for i in range(4):
        (worktree / "README.md").write_text(f"# v{i}\n", encoding="utf-8")
        create_snapshot(worktree, TASK, "coding", keep=2)
    snapshots = list_snapshots(worktree, TASK)
    assert len(snapshots) == 2
    assert snapshots[0].snapshot_id > snapshots[1].snapshot_id


def test_rollback_restores_files_branch_and_untracked_state(task_project):
    _project, worktree, spec_dir = task_project
    (worktree / "draft.txt").write_text("kept\n", encoding="utf-8")
    (worktree / "node_modules").mkdir()
    (worktree / "node_modules" / "dep.js").write_text("x", encoding="utf-8")
    snapshot = create_snapshot(worktree, TASK, "coding")

    # What a session gone wrong does: edits, deletes, adds, commits.
    (worktree / "src" / "app.py").write_text("print('broken')\n", encoding="utf-8")
    (worktree / "README.md").unlink()
    (worktree / "draft.txt").unlink()
    (worktree / "junk.txt").write_text("junk\n", encoding="utf-8")
    git(worktree, "add", "-A")
    git(worktree, "commit", "-q", "-m", "agent commit")
    (worktree / "src" / "extra.py").write_text("x = 1\n", encoding="utf-8")
    (spec_dir / "implementation_plan.json").write_text('{"v": 2}', encoding="utf-8")

    result = rollback(worktree, TASK, snapshot.snapshot_id)

    assert result["restored"] == snapshot.snapshot_id
    assert git(worktree, "rev-parse", "HEAD") == snapshot.head
    assert (worktree / "src" / "app.py").read_text(encoding="utf-8") == "print('v1')\n"
    assert (worktree / "README.md").is_file()
    assert (worktree / "draft.txt").read_text(encoding="utf-8") == "kept\n"
    assert not (worktree / "junk.txt").exists()
    assert not (worktree / "src" / "extra.py").exists()
    # Ignored files and the build's own state are left alone.
    assert (worktree / "node_modules" / "dep.js").is_file()
    assert (spec_dir / "implementation_plan.json").read_text(
        encoding="utf-8"
    ) == '{"v": 2}'


def test_a_rollback_can_be_undone(task_project):
    _project, worktree, _spec = task_project
    snapshot = create_snapshot(worktree, TASK, "coding")
    (worktree / "src" / "app.py").write_text("print('v3')\n", encoding="utf-8")

    result = rollback(worktree, TASK, snapshot.snapshot_id)
    assert (worktree / "src" / "app.py").read_text(encoding="utf-8") == "print('v1')\n"

    rollback(worktree, TASK, result["safety"])
    assert (worktree / "src" / "app.py").read_text(encoding="utf-8") == "print('v3')\n"


def test_rollback_refuses_unknown_or_malformed_ids(task_project):
    _project, worktree, _spec = task_project
    with pytest.raises(SnapshotError):
        rollback(worktree, TASK, "20260101T000000000000Z-coding")
    with pytest.raises(SnapshotError):
        rollback(worktree, TASK, "../../heads/main")


def test_only_a_task_worktree_is_accepted(task_project):
    project, worktree, _spec = task_project
    assert worktree_of(project, TASK) == worktree.resolve()
    with pytest.raises(SnapshotError):
        worktree_of(project, "../..")
    with pytest.raises(SnapshotError):
        worktree_of(project, "002-missing")
    # A folder named like a task but that is not its own worktree.
    fake = project / ".workpilot" / "worktrees" / "tasks" / "003-fake"
    fake.mkdir(parents=True)
    (fake / ".git").write_text("gitdir: nowhere\n", encoding="utf-8")
    with pytest.raises(SnapshotError):
        worktree_of(project, "003-fake")


@pytest.mark.parametrize(
    "name,ok",
    [
        ("001-add-login", True),
        ("a.b_c", True),
        ("../x", False),
        ("x..y", False),
        (".hidden", False),
        ("x.lock", False),
        ("a/b", False),
        ("", False),
    ],
)
def test_task_names_are_single_ref_components(name: str, ok: bool):
    assert valid_task_name(name) is ok


def test_a_repository_without_identity_still_snapshots(task_project, monkeypatch):
    _project, worktree, _spec = task_project
    git(worktree, "config", "--unset", "user.name")
    monkeypatch.setenv("HOME", str(Path(worktree).parent))
    (worktree / "README.md").write_text("# changed\n", encoding="utf-8")
    assert create_snapshot(worktree, TASK, "coding").snapshot_id
