"""The Learning Loop runner, as the desktop app starts it.

Recording a verdict writes `task_outcome.json` in the spec and files the
outcome in the shared brain; the analysis then runs on the builds. Each test
gives the runner its own home folder and brain and turns the
model analysis off with `WORKPILOT_LEARNING_LOOP_MODEL=0`, so no provider is
called: the rules-based extraction still runs.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "learning_loop_runner.py"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    return folder


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / ".workpilot" / "specs" / "001-cart").mkdir(parents=True)
    return root


def _run(home: Path, project: Path, *args: str) -> tuple[int, list[dict], str]:
    env = {
        **os.environ,
        "HOME": str(home),
        "USERPROFILE": str(home),
        "WORKPILOT_LEARNING_LOOP_MODEL": "0",
        # conftest points the brain at a throwaway folder; this one is the test's.
        "WORKPILOT_BRAIN_DIR": str(home / "brain"),
    }
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
        check=False,
    )
    events = [
        json.loads(line.split(":", 1)[1])
        for line in done.stdout.splitlines()
        if line.startswith("LEARNING_LOOP_EVENT:")
    ]
    return done.returncode, events, done.stderr


def _outcome(project: Path) -> dict:
    path = project / ".workpilot" / "specs" / "001-cart" / "task_outcome.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_a_project_without_builds_analyses_to_an_empty_report(home, project):
    code, events, _ = _run(home, project)
    assert code == 0
    assert events[0]["message"] == "Running full project analysis..."
    assert events[0]["data"] == {"progress": 10}
    assert events[1:3] == [
        {
            "type": "status",
            "data": {"progress": 0},
            "message": "Gathering data from all builds...",
        },
        {
            "type": "stream_chunk",
            "data": "[Status] Gathering data from all builds...\n",
        },
    ]
    done = events[-1]
    assert done["type"] == "complete"
    assert done["data"]["report"]["analyzed_builds"] == 0
    assert done["data"]["patterns"] == []


def test_verdicts_are_kept_with_their_history_and_analysed(home, project):
    code, events, _ = _run(
        home,
        project,
        "--spec-id",
        "001-cart",
        "--record-outcome",
        "build_failed",
        "--outcome-details",
        "CI: " + "x" * 3000,
    )
    assert code == 0, events
    assert events[0]["message"] == "Recorded outcome 'build_failed' for 001-cart"
    first = _outcome(project)
    assert first["verdict"] == "build_failed"
    assert len(first["details"]) == 2000

    code, events, _ = _run(
        home, project, "--spec-id", "001-cart", "--record-outcome", "approved"
    )
    assert code == 0
    latest = _outcome(project)
    assert latest["verdict"] == "approved"
    assert [h["verdict"] for h in latest["history"]] == ["build_failed", "approved"]
    assert "Analyzing build 001-cart..." in [e.get("message") for e in events]
    assert events[-1]["data"]["report"]["analyzed_builds"] == 1
    # The shared brain now holds the outcome, under the project's name.
    [note] = (home / "brain" / "knowledge" / "projects" / "shop").rglob("001-cart*.md")
    assert "approved" in note.read_text(encoding="utf-8")


def test_a_damaged_outcome_file_starts_a_new_history(home, project) -> None:
    path = project / ".workpilot" / "specs" / "001-cart" / "task_outcome.json"
    path.write_text("{not json", encoding="utf-8")
    code, _, _ = _run(
        home, project, "--spec-id", "001-cart", "--record-outcome", "rejected"
    )
    assert code == 0
    assert [h["verdict"] for h in _outcome(project)["history"]] == ["rejected"]


def test_an_unknown_spec_is_refused(home, project) -> None:
    code, events, _ = _run(
        home, project, "--spec-id", "404-gone", "--record-outcome", "approved"
    )
    assert code == 1
    assert events == [
        {"type": "error", "message": "Spec directory not found: 404-gone"}
    ]
    code, events, _ = _run(home, project, "--spec-id", "404-gone")
    assert code == 0
    assert events == [
        {"type": "error", "message": "Spec directory not found: 404-gone"}
    ]


def test_a_verdict_needs_a_spec(home, project) -> None:
    code, _, err = _run(home, project, "--record-outcome", "approved")
    assert code == 2 and "--record-outcome requires --spec-id" in err


# --- in-process: what fails around the analysis ----------------------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch, home: Path):
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("WORKPILOT_LEARNING_LOOP_MODEL", "0")
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("learning_loop_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _events(capsys) -> list[dict]:
    return [
        json.loads(line.split(":", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("LEARNING_LOOP_EVENT:")
    ]


def test_a_brain_that_cannot_save_does_not_lose_the_verdict(
    runner, project, monkeypatch, capsys
) -> None:
    import memory.store

    def broken(*_a, **_k):
        raise OSError("read-only home")

    monkeypatch.setattr(memory.store, "get_project_memory", broken)
    spec_dir = asyncio.run(runner.record_outcome(str(project), "001-cart", "rejected"))
    assert spec_dir == project / ".workpilot" / "specs" / "001-cart"
    assert _outcome(project)["verdict"] == "rejected"
    assert (
        _events(capsys)[-1]["message"] == "Brain outcome save skipped: read-only home"
    )


def test_a_brain_turned_off_keeps_only_the_file(
    runner, project, monkeypatch, capsys
) -> None:
    import memory.store

    monkeypatch.setattr(memory.store, "get_project_memory", lambda *_a: None)
    asyncio.run(runner.record_outcome(str(project), "001-cart", "approved", "ok"))
    assert _outcome(project)["details"] == "ok"
    assert [e["message"] for e in _events(capsys)] == [
        "Recorded outcome 'approved' for 001-cart"
    ]


def test_a_failed_analysis_ends_with_an_error(runner, project, monkeypatch, capsys):
    from learning_loop.service import LearningLoopService

    async def boom(self, **_k):
        raise RuntimeError("no builds folder")

    monkeypatch.setattr(LearningLoopService, "run_full_analysis", boom)
    with pytest.raises(SystemExit) as stop:
        asyncio.run(runner.run_analysis(str(project)))
    assert stop.value.code == 1
    assert _events(capsys)[-1] == {"type": "error", "message": "no builds folder"}


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (KeyboardInterrupt, "Analysis cancelled by user"),
        (RuntimeError("loop closed"), "loop closed"),
    ],
)
def test_an_interrupt_or_a_crash_of_the_run(
    runner, project, monkeypatch, capsys, error, message
) -> None:
    def stop_run(coroutine):
        coroutine.close()
        raise error

    monkeypatch.setattr(runner.asyncio, "run", stop_run)
    monkeypatch.setattr(sys, "argv", ["runner", "--project-dir", str(project)])
    with pytest.raises(SystemExit):
        runner.main()
    assert _events(capsys)[-1] == {"type": "error", "message": message}
