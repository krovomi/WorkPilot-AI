"""The runner the app calls to list a task's snapshots and restore one."""

from __future__ import annotations

from agent_snapshots import create_snapshot
from runners.snapshot_runner import run

from .conftest import TASK


def test_list_then_rollback(task_project):
    project, worktree, _spec = task_project
    snapshot = create_snapshot(worktree, TASK, "coding")
    (worktree / "README.md").write_text("# changed\n", encoding="utf-8")

    listed = run(["list", "--project-dir", str(project), "--task", TASK])
    assert [s["snapshot_id"] for s in listed["snapshots"]] == [snapshot.snapshot_id]

    result = run(
        [
            "rollback",
            "--project-dir",
            str(project),
            "--task",
            TASK,
            "--snapshot",
            snapshot.snapshot_id,
        ]
    )
    assert result["restored"] == snapshot.snapshot_id
    assert (worktree / "README.md").read_text(encoding="utf-8") == "# demo\n"


def test_the_main_checkout_is_never_a_target(task_project):
    project, _worktree, _spec = task_project
    for task in ("..", "../../..", "002-missing", "x/../../"):
        result = run(["list", "--project-dir", str(project), "--task", task])
        assert "error" in result


def test_rollback_needs_a_known_snapshot(task_project):
    project, _worktree, _spec = task_project
    base = ["rollback", "--project-dir", str(project), "--task", TASK]
    assert "error" in run(base)
    assert "error" in run([*base, "--snapshot", "HEAD~1"])
