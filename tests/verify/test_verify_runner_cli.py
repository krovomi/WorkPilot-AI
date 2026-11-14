"""The verification runner, as the CLI and the desktop app start it.

The project here has nothing to launch, so `run` ends at once without starting
an app or a model; the one verdict that needs a launched app (a failure) is
played in-process with a stand-in loop.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "verify_runner.py"
MARKER = "__VERIFY_RESULT__:"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "tool"
    root.mkdir()
    _git(root, "init", "-q")
    (root / "notes.txt").write_text("nothing to run\n", encoding="utf-8")
    (root / ".workpilot" / "specs" / "001-notes").mkdir(parents=True)
    return root


def _spec(project: Path) -> str:
    return str(project / ".workpilot" / "specs" / "001-notes")


def _run(project: Path, *args: str) -> tuple[int, dict, list[str]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    lines = done.stdout.splitlines()
    [result] = [ln for ln in lines if ln.startswith(MARKER)]
    return done.returncode, json.loads(result[len(MARKER) :]), lines


def test_a_project_with_nothing_to_launch_is_not_applicable(project: Path) -> None:
    code, out, _ = _run(project, "--action", "detect")
    assert code == 0 and out["success"] is True
    assert out["applicable"] is False and out["targets"] == []

    code, out, _ = _run(project, "--action", "run", "--no-agent", "--effort", "low")
    assert code == 0
    assert out["record"]["status"] == "not-applicable"


def test_a_run_for_a_task_reads_its_qa_provider(project: Path) -> None:
    code, out, _ = _run(
        project, "--action", "run", "--spec-dir", _spec(project), "--effort", "low"
    )
    assert code == 0
    assert out["record"]["status"] == "not-applicable"
    assert out["record"]["provider"]

    code, out, _ = _run(project, "--action", "status", "--spec-dir", _spec(project))
    assert code == 0 and out["record"]["status"] == "not-applicable"
    assert out["settings"]["decidedBy"] == "default"


def test_status_before_any_run_has_no_record(project: Path) -> None:
    code, out, _ = _run(project, "--action", "status")
    assert code == 0 and out["record"] is None and out["settings"]["enabled"] is True


@pytest.mark.parametrize(
    ("action", "key"), [("replay", "replay"), ("compare", "compare")]
)
def test_nothing_verified_has_nothing_to_replay(project: Path, action, key) -> None:
    code, out, _ = _run(project, "--action", action, "--spec-dir", _spec(project))
    assert code == 0 and out[key]["status"] == "skipped"


@pytest.mark.parametrize(
    ("action", "error"),
    [
        ("replay", "--spec-dir is required for a replay"),
        ("compare", "--spec-dir is required to compare"),
    ],
)
def test_replay_and_compare_need_a_task(project: Path, action, error) -> None:
    code, out, _ = _run(project, "--action", action)
    assert code == 1 and out == {"success": False, "error": error}


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, out, _ = _run(tmp_path / "gone", "--action", "detect")
    assert code == 1 and out["error"].startswith("no such directory:")


def test_a_failed_verification_exits_with_two(project, monkeypatch, capsys) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    import verify.loop

    async def failed(_project, _spec, _runner, options):
        options.log("round 1: the page did not load")
        return {"status": "fail", "findings": ["blank page"]}

    monkeypatch.setattr(verify.loop, "run_verify_loop", failed)
    spec = importlib.util.spec_from_file_location("verify_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(
        sys,
        "argv",
        ["runner", "--action", "run", "--project-dir", str(project), "--no-agent"],
    )
    assert module.main() == 2
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "round 1: the page did not load"
    assert json.loads(lines[-1][len(MARKER) :])["record"]["status"] == "fail"
