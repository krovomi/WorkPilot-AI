"""The edges of the session watch, the snapshot store and the sandbox checks.

What a malformed path, a broken git state, a failing snapshot or a report that
cannot be written does: never an exception into the session, never a write
the policy refuses.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from agent_snapshots import (
    SnapshotError,
    create_snapshot,
    list_snapshots,
    task_worktree,
    worktree_of,
)
from agent_snapshots.store import NAMESPACE, _ScratchIndex
from agents import safety_watch as safety_watch_module
from agents.safety_events import call_events, event_path
from agents.safety_watch import REPORT_FILE, SafetyWatch
from agents.session_guards import SessionGuards
from security.agent_safety_settings import ENV_VAR, parse_settings
from security.anomaly_detector import dangerous_command_match, sensitive_path_match
from security.sandbox import SandboxPolicy, project_relative, write_refusal

from .conftest import TASK, git

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def _run(watch: SafetyWatch, name: str, args: dict, call_id: str | None = "c") -> bool:
    watch.call(name, args, call_id)
    return watch.result("ok", False, call_id)


# -- snapshot store ---------------------------------------------------------------


def test_a_path_that_cannot_be_resolved_is_no_worktree(tmp_path: Path):
    assert task_worktree("bad\0path") is None
    lookalike = tmp_path / ".workpilot" / "worktrees" / "tasks" / TASK / "spec"
    lookalike.mkdir(parents=True)
    assert task_worktree(lookalike) is None  # no .git: not a worktree


def test_a_folder_inside_the_project_is_not_taken_for_a_worktree(task_project):
    project, _worktree, _spec = task_project
    fake = project / ".workpilot" / "worktrees" / "tasks" / "002-fake"
    (fake / ".git").mkdir(parents=True)
    with pytest.raises(SnapshotError):
        worktree_of(project, "002-fake")


def test_bad_names_and_labels_are_refused(task_project):
    _project, worktree, _spec = task_project
    with pytest.raises(SnapshotError, match="task name"):
        list_snapshots(worktree, "../x")
    with pytest.raises(SnapshotError, match="task name"):
        create_snapshot(worktree, "../x")
    with pytest.raises(SnapshotError, match="label"):
        create_snapshot(worktree, TASK, label="Bad-Label")


def test_foreign_refs_in_the_namespace_are_ignored(task_project):
    _project, worktree, _spec = task_project
    kept = create_snapshot(worktree, TASK, "coding")
    root = git(worktree, "rev-parse", "HEAD")
    git(worktree, "update-ref", f"{NAMESPACE}/{TASK}/not-a-snapshot", root)
    # A valid name on a commit without a parent: not one this store made.
    git(
        worktree,
        "update-ref",
        f"{NAMESPACE}/{TASK}/20260101T000000000000Z-coding",
        root,
    )
    assert [s.snapshot_id for s in list_snapshots(worktree, TASK)] == [kept.snapshot_id]


def test_the_scratch_index_copes_with_a_main_checkout_and_no_index(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    with _ScratchIndex(repo) as index:  # relative git path, no index yet
        assert not index.exists()
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    git(repo, "add", "a.txt")
    with _ScratchIndex(repo) as index:
        assert index.is_file()
    assert not index.parent.exists()


# -- events -------------------------------------------------------------------------


def test_odd_tool_calls_give_safe_events(tmp_path: Path):
    assert event_path("bad\0path", tmp_path) == "bad\0path"
    assert call_events("Read", {}, tmp_path) == []
    assert call_events("Read", {"file_path": 3, "path": " "}, tmp_path) == []
    assert call_events("glob", {"path": "src"}, tmp_path) == []
    assert call_events("delete_file", {"path": "old.py"}, tmp_path) == [
        ("file_delete", {"path": "old.py"})
    ]
    events = call_events(
        "Bash", {"command": "git rm -r old/ && rm 'unclosed"}, tmp_path
    )
    assert ("file_delete", {"path": "old"}) in events
    assert call_events("Bash", {"command": "ls |"}, tmp_path) == [
        ("command_exec", {"command": "ls |"})
    ]


# -- the watch ----------------------------------------------------------------------


def test_a_failed_snapshot_leaves_the_session_without_one(task_project, monkeypatch):
    _project, _worktree, spec = task_project

    def broken(*_a, **_k):
        raise SnapshotError("git is gone")

    monkeypatch.setattr(safety_watch_module, "create_snapshot", broken)
    watch = SafetyWatch(spec, "coding", parse_settings({}))
    assert watch.snapshot_id is None


def test_results_are_matched_to_their_calls(task_project):
    _project, _worktree, spec = task_project
    watch = SafetyWatch(spec, "coding", parse_settings({}))
    assert watch.result("ok", False, None) is False  # nothing pending
    watch.call("Read", {"file_path": "README.md"}, None)
    assert watch.result("ok", False, None) is False  # in order
    watch.call("Read", {"file_path": "README.md"}, "id-1")
    assert watch.result("ok", False, None) is False  # the oldest pending one
    assert watch._pending == {}


def test_no_result_counts_once_the_watch_has_tripped(task_project):
    _project, worktree, spec = task_project
    settings = parse_settings(
        {"sandbox": {"mode": "restricted", "allowedPaths": ["src"]}}
    )
    watch = SafetyWatch(spec, "coding", settings)
    (worktree / "setup.py").write_text("x", encoding="utf-8")
    assert _run(watch, "Write", {"file_path": str(worktree / "setup.py")}) is True
    assert _run(watch, "Write", {"file_path": str(worktree / "other.py")}) is False


def test_writes_outside_the_project_and_without_a_size_limit(task_project, tmp_path):
    _project, worktree, spec = task_project
    watch = SafetyWatch(
        spec, "coding", parse_settings({"sandbox": {"maxFileSizeMb": 0}})
    )
    assert _run(watch, "Write", {"file_path": str(tmp_path / "elsewhere.txt")}) is False
    big = worktree / "src" / "big.bin"
    big.write_bytes(b"x" * 2048)
    assert _run(watch, "Write", {"file_path": str(big)}) is False
    assert watch._written == {"src/big.bin"}


def test_a_failed_restore_is_reported_on_the_pause(task_project, monkeypatch):
    _project, worktree, spec = task_project

    def broken(*_a, **_k):
        raise SnapshotError("reset failed")

    monkeypatch.setattr(safety_watch_module, "rollback", broken)
    settings = parse_settings(
        {"sandbox": {"mode": "restricted", "allowedPaths": ["src"]}}
    )
    watch = SafetyWatch(spec, "coding", settings)
    (worktree / "setup.py").write_text("x", encoding="utf-8")
    assert _run(watch, "Write", {"file_path": str(worktree / "setup.py")})
    watch.close()
    assert watch.detail["rollbackError"] == "reset failed"
    assert "rolledBack" not in watch.detail


def test_the_report_keeps_earlier_sessions_and_mends_a_bad_one(task_project):
    _project, _worktree, spec = task_project
    report = spec / REPORT_FILE
    report.write_text(json.dumps({"sessions": "not a list"}), encoding="utf-8")
    off = parse_settings({"anomaly": {"enabled": False}})
    SafetyWatch(spec, "coding", off).close()
    SafetyWatch(spec, "planning", off).close()
    sessions = json.loads(report.read_text(encoding="utf-8"))["sessions"]
    assert [s["phase"] for s in sessions] == ["coding", "planning"]
    assert "trustScore" not in sessions[0]


def test_a_report_that_cannot_be_written_never_fails_the_session(task_project):
    _project, _worktree, spec = task_project
    (spec / REPORT_FILE).mkdir()
    SafetyWatch(spec, "coding", parse_settings({})).close()
    assert (spec / REPORT_FILE).is_dir()


def test_a_watch_that_breaks_mid_session_leaves_the_breaker(task_project, monkeypatch):
    _project, _worktree, spec = task_project
    guards = SessionGuards(spec, "coding")
    assert guards.safety is not None

    def broken(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(guards.safety, "call", broken)
    monkeypatch.setattr(guards.safety, "result", broken)
    monkeypatch.setattr(guards.safety, "close", broken)
    guards.call("Read", {"file_path": "README.md"}, "c")
    assert guards.result("ok", False, "c") is False
    guards.close()
    assert guards.tripped is False


# -- sandbox checks -------------------------------------------------------------------


def test_unresolvable_targets_are_never_inside_the_project(tmp_path: Path):
    assert project_relative("src/a.py", None) is None
    assert project_relative("bad\0path", tmp_path) is None
    restricted = SandboxPolicy(mode="restricted", allowed_paths=("src",))
    # Outside the project is the write roots' decision (path_guard), not ours.
    assert write_refusal(restricted, "bad\0path", tmp_path) is None


def test_the_executor_refuses_content_over_the_size_limit(tmp_path, monkeypatch):
    from core.runtimes.tool_executor import ToolExecutor

    monkeypatch.setenv(ENV_VAR, json.dumps({"sandbox": {"maxFileSizeMb": 0.001}}))
    executor = ToolExecutor(project_dir=tmp_path, agent_type="coder")
    with pytest.raises(ValueError, match="limit"):
        asyncio.run(executor._write_file("big.txt", "x" * 4096))
    asyncio.run(executor._write_file("small.txt", "ok"))
    asyncio.run(executor._write_file("empty.txt", None, empty_file=True))
    assert (tmp_path / "small.txt").read_text(encoding="utf-8") == "ok"


def test_a_nan_is_the_default():
    settings = parse_settings({"sandbox": {"maxFileSizeMb": float("nan")}})
    assert settings.sandbox.max_file_size_mb == 10.0


# -- anomaly matchers -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("", None),
        ("/", None),
        (".ssh", ".ssh/"),
        ("/home/dev/passwd", None),
        ("/etc/passwd", "passwd"),
    ],
)
def test_sensitive_paths_on_whole_names(path: str, expected: str | None):
    assert sensitive_path_match(path) == expected


def test_dangerous_commands_with_odd_shapes():
    assert dangerous_command_match("echo 'unclosed") is None
    assert dangerous_command_match("ls |") is None
    assert dangerous_command_match("cat image > /dev/sda") == "> /dev/"


# -- the runner -----------------------------------------------------------------------


def test_the_runner_reports_an_unreadable_worktree(task_project, monkeypatch, capsys):
    from runners import snapshot_runner

    project, _worktree, _spec = task_project

    def unreadable(*_a, **_k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(snapshot_runner, "worktree_of", unreadable)
    args = ["list", "--project-dir", str(project), "--task", TASK]
    assert snapshot_runner.main(args) == 1
    assert json.loads(capsys.readouterr().out) == {
        "error": "cannot read the worktree: Permission denied"
    }


def test_the_runner_as_the_app_starts_it(task_project):
    project, worktree, _spec = task_project
    create_snapshot(worktree, TASK, "coding")
    result = subprocess.run(
        [
            sys.executable,
            str(BACKEND / "runners" / "snapshot_runner.py"),
            "list",
            "--project-dir",
            str(project),
            "--task",
            TASK,
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert len(json.loads(result.stdout.strip().splitlines()[-1])["snapshots"]) == 1
