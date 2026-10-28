"""Running the goal: the exit code decides, a hang is unmet, a missing program is an error."""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

import pytest
from foundation.platform import is_windows
from goal.check import command_script, run_goal
from goal.spec import GoalSpec


def _q(arg: str) -> str:
    """Quote one argument the way ``split_command`` reads it on this OS."""
    return subprocess.list2cmdline([arg]) if is_windows() else shlex.quote(arg)


PY = _q(sys.executable)


def _spec(code: str, **kwargs) -> GoalSpec:
    return GoalSpec(command=f"{PY} -c {_q(code)}", **kwargs)


def test_the_expected_exit_code_is_met(tmp_path: Path):
    run = run_goal(_spec("print('ok')"), tmp_path)
    assert run.status == "met"
    assert run.exit_code == 0
    assert "ok" in run.output_tail


def test_another_exit_code_is_unmet_with_its_output(tmp_path: Path):
    run = run_goal(_spec("import sys; print('3 failed'); sys.exit(1)"), tmp_path)
    assert run.status == "unmet"
    assert run.exit_code == 1
    assert "3 failed" in run.output_tail
    assert "exit code 1, expected 0" in run.detail


def test_a_non_zero_expected_code(tmp_path: Path):
    assert (
        run_goal(_spec("raise SystemExit(3)", expected_exit=3), tmp_path).status
        == "met"
    )
    assert run_goal(_spec("pass", expected_exit=3), tmp_path).status == "unmet"


def test_a_hang_is_unmet_and_killed(tmp_path: Path):
    spec = _spec("import time; time.sleep(60)")
    # Below the parser's floor on purpose: the runner takes what it is given.
    object.__setattr__(spec, "timeout_s", 1)
    run = run_goal(spec, tmp_path)
    assert run.status == "unmet"
    assert run.timed_out is True
    assert run.exit_code is None
    assert run.duration_s < 30


def test_a_missing_program_is_an_error(tmp_path: Path):
    run = run_goal(GoalSpec(command="definitely-not-a-program-xyz --flag"), tmp_path)
    assert run.status == "error"
    assert "could not start" in run.detail


def test_no_shell_reads_the_line(tmp_path: Path):
    marker = tmp_path / "pwned"
    run_goal(
        GoalSpec(command=f"{PY} -c pass ; touch {_q(str(marker))}"),
        tmp_path,
    )
    assert not marker.exists()


def test_credentials_do_not_reach_the_command(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("GOAL_VISIBLE", "yes")
    run = run_goal(
        _spec(
            "import os; print(os.environ.get('OPENAI_API_KEY'), os.environ.get('GOAL_VISIBLE'))"
        ),
        tmp_path,
    )
    assert "None yes" in run.output_tail


def test_the_script_the_command_runs_is_found(tmp_path: Path):
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "check.sh").write_text("exit 0\n", encoding="utf-8")
    assert (
        command_script(GoalSpec(command="./scripts/check.sh"), tmp_path)
        == "scripts/check.sh"
    )
    assert (
        command_script(GoalSpec(command="bash scripts/check.sh"), tmp_path)
        == "scripts/check.sh"
    )
    assert command_script(GoalSpec(command="npm test"), tmp_path) is None
    assert command_script(GoalSpec(command="../outside.sh"), tmp_path) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")
def test_a_timeout_takes_the_children_too(tmp_path: Path):
    pid_file = tmp_path / "child.pid"
    code = (
        "import subprocess, sys, time;"
        f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
        f"open({str(pid_file)!r}, 'w').write(str(p.pid));"
        "time.sleep(60)"
    )
    spec = _spec(code)
    object.__setattr__(spec, "timeout_s", 2)
    assert run_goal(spec, tmp_path).timed_out
    child = int(pid_file.read_text(encoding="utf-8"))

    def _alive() -> bool:
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            return False
        # A zombie awaiting its reaper is dead for our purpose.
        status = Path(f"/proc/{child}/status")
        return status.exists() and "zombie" not in status.read_text(encoding="utf-8")

    # The group is killed before run_goal returns, but a loaded machine may take a
    # moment to deliver the signal: wait for it, far below the child's own 60 s.
    deadline = time.monotonic() + 5
    while _alive() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive()
