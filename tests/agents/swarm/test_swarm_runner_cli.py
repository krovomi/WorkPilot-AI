"""The Swarm runner, as the desktop app starts it.

`--analyze-only` runs for real on a spec's implementation plan: the waves it
prints and emits are what the Swarm page shows. Running the waves starts
coder agents, so that part runs in-process with a stand-in orchestrator.
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

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "swarm_runner.py"
PREFIX = "__SWARM_EVENT__:"

PLAN = {
    "phases": [
        {
            "name": "build",
            "subtasks": [
                {
                    "id": "s1",
                    "description": "Create the login form component, with its "
                    "validation rules and error messages",
                    "files_to_create": ["src/login.tsx"],
                },
                {
                    "id": "s2",
                    "description": "Wire the form",
                    "files_to_modify": ["src/login.tsx"],
                    "depends_on": ["s1"],
                },
                {
                    "id": "s3",
                    "description": "API route",
                    "files_to_create": ["api/login.py"],
                },
                {"id": "s0", "description": "done already", "status": "completed"},
            ],
        }
    ]
}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    spec = tmp_path / "app" / ".workpilot" / "specs" / "007-login"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(json.dumps(PLAN), "utf-8")
    (spec.parent / "008-empty").mkdir()
    return tmp_path / "app"


def _run(project: Path, *args: str) -> tuple[int, list[dict], list[str]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), *args],
        cwd=BACKEND,
        # The app starts its runners with UTF-8 output (pythonRunnerEnv);
        # without it, Windows writes the banner's dash in its code page and
        # the UTF-8 read below fails.
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    events, lines = [], []
    for line in done.stdout.splitlines():
        if line.startswith(PREFIX):
            events.append(json.loads(line[len(PREFIX) :]))
        else:
            lines.append(line)
    return done.returncode, events, lines


def test_the_analysis_groups_independent_subtasks_into_waves(project: Path):
    code, events, lines = _run(
        project,
        "--spec",
        "007",
        "--analyze-only",
        "--max-parallel",
        "2",
        "--fail-fast",
        "--no-merge",
        "--dry-run",
    )
    assert code == 0
    started, analysis = events
    assert started["type"] == "swarm_started" and started["analyze_only"] is True
    assert started["spec_dir"].endswith("007-login")
    assert started["config"]["max_parallel_agents"] == 2
    assert started["config"]["fail_fast"] is True
    assert started["config"]["merge_after_each_wave"] is False
    assert started["config"]["dry_run"] is True
    assert analysis["type"] == "analysis_complete"
    assert [w["subtask_ids"] for w in analysis["waves"]] == [["s1", "s3"], ["s2"]]
    assert analysis["parallelism_stats"]["speedup_estimate"] == 1.5
    assert "  Subtasks:      3" in lines and "  Est. speedup:  1.5x" in lines
    # A description is cut at 50 characters in the printed waves.
    assert "    [s1] Create the login form component, with its validati" in lines
    assert lines.index("  Wave 2:") < lines.index("    [s2] Wire the form")


def test_a_spec_without_a_plan_fails(project: Path) -> None:
    code, events, _ = _run(project, "--spec", "008-empty", "--analyze-only")
    assert code == 1
    assert events[-1] == {
        "type": "swarm_failed",
        "error": "No implementation_plan.json found",
    }


@pytest.mark.parametrize("specs", [True, False])
def test_an_unknown_spec_is_named(tmp_path: Path, project: Path, specs: bool):
    root = project if specs else tmp_path / "bare"
    root.mkdir(exist_ok=True)
    code, _, lines = _run(root, "--spec", "999")
    assert code == 1
    assert lines == [
        f"Error: Spec '999' not found in {root.resolve() / '.workpilot' / 'specs'}"
    ]


# --- in-process: the run itself, with a stand-in orchestrator ---------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("swarm_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(("phase", "code"), [("complete", None), ("failed", 1)])
def test_the_waves_run_and_the_outcome_sets_the_exit_code(
    runner, project: Path, monkeypatch, capsys, phase: str, code
) -> None:
    from agents.swarm.types import SwarmPhase

    seen = {}

    class Status:
        def __init__(self) -> None:
            self.phase = SwarmPhase(phase)
            self.completed_subtasks = 3 if phase == "complete" else 1
            self.total_subtasks = 3
            self.failed_subtasks = 0 if phase == "complete" else 2

        def to_dict(self) -> dict:
            return {"phase": phase}

    class StandIn:
        def __init__(self, project_dir, spec_dir, config, model):
            seen.update(project=project_dir, spec=spec_dir.name, model=model)

        async def run(self):
            return Status()

    monkeypatch.setattr(runner, "SwarmOrchestrator", StandIn)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "swarm",
            "--spec",
            "007-login",
            "--project-dir",
            str(project),
            "--model",
            "haiku",
        ],
    )
    if code is None:
        runner.main()
    else:
        with pytest.raises(SystemExit) as stop:
            runner.main()
        assert stop.value.code == code
    out = capsys.readouterr().out
    assert seen == {"project": project.resolve(), "spec": "007-login", "model": "haiku"}
    assert "  SWARM MODE — Execution Complete" in out
    assert f"  Status:    {phase}" in out
    assert "  Completed: 3/3" in out if phase == "complete" else "  Failed:    2" in out

    result = asyncio.run(
        runner.run_swarm(project, project / ".workpilot" / "specs" / "007-login")
    )
    assert result["success"] is (phase == "complete")
    assert result["status"] == {"phase": phase}
