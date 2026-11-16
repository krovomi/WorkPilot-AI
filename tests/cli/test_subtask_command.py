"""``run.py --subtask``: the coder loop kept on one subtask, as a swarm runs it.

The coder itself is replaced by a stand-in that does to the plan what a
session does (or fails to); the plan, ``core.progress`` and the command are
real.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import core.agent
import pytest
from cli.subtask_command import handle_subtask_command
from core.progress import SWARM_SUBTASK_ENV, get_next_subtask
from foundation.build_signals import BuildHalted


@pytest.fixture
def spec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # Recorded, so what the command sets is undone after the test.
    monkeypatch.setenv(SWARM_SUBTASK_ENV, "")
    monkeypatch.delenv(SWARM_SUBTASK_ENV)
    spec = tmp_path / ".workpilot" / "specs" / "004-cart"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [
                    {
                        "name": "Backend",
                        "subtasks": [
                            {"id": "api", "status": "pending"},
                            {"id": "db", "status": "pending"},
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return spec


def _complete(spec: Path, subtask_id: str) -> None:
    plan_file = spec / "implementation_plan.json"
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    for subtask in plan["phases"][0]["subtasks"]:
        if subtask["id"] == subtask_id:
            subtask["status"] = "completed"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")


def _coder(monkeypatch: pytest.MonkeyPatch, session) -> list[dict]:
    runs: list[dict] = []

    async def run_autonomous_agent(**kwargs):
        runs.append(kwargs)
        session(kwargs["spec_dir"])

    monkeypatch.setattr(core.agent, "run_autonomous_agent", run_autonomous_agent)
    return runs


def test_the_coder_builds_that_subtask_and_succeeds(spec, monkeypatch):
    def session(spec_dir):
        # What the coder loop asks for: the worker's subtask, not the plan's first.
        nxt = get_next_subtask(spec_dir)
        _complete(spec_dir, nxt["id"])
        assert get_next_subtask(spec_dir) is None

    runs = _coder(monkeypatch, session)

    assert handle_subtask_command(spec.parent.parent.parent, spec, "opus", "db")
    assert os.environ[SWARM_SUBTASK_ENV] == "db"
    [run] = runs
    assert run["spec_dir"] == spec and run["project_dir"] == spec.parents[2]
    assert run["model"]  # resolved for the coding phase
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert [s["status"] for s in plan["phases"][0]["subtasks"]] == [
        "pending",
        "completed",
    ]


def test_a_coder_that_stops_fails_the_worker(spec, monkeypatch, capsys):
    def session(_spec_dir):
        raise BuildHalted("coding", "the tests do not pass")

    _coder(monkeypatch, session)

    assert not handle_subtask_command(spec.parents[2], spec, None, "api")
    assert "Subtask api stopped: " in capsys.readouterr().err


def test_a_subtask_left_unfinished_fails_the_worker(spec, monkeypatch, capsys):
    _coder(monkeypatch, lambda _spec_dir: None)

    assert not handle_subtask_command(spec.parents[2], spec, None, "api")
    assert capsys.readouterr().err.strip() == "Subtask api was not completed"


def test_without_a_plan_nothing_runs(spec, tmp_path, monkeypatch, capsys):
    runs = _coder(monkeypatch, lambda _spec_dir: None)

    assert not handle_subtask_command(tmp_path, tmp_path, None, "api")
    assert runs == []
    assert "No plan to take subtask api from" in capsys.readouterr().err
