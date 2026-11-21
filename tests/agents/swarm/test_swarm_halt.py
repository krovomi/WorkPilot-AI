"""agents.swarm.halt: whether the swarm may start its next wave (#353, lot 3).

What these tests keep away: a swarm that launches wave after wave while the
card says the task is paused (a worker's pause lands in the main project's
copy, not in the task worktree's one the orchestrator holds), or while
workpilot.policy.yaml says agents must stop.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml
from agents.swarm.halt import stop_reason
from foundation.pause_state import read_pause_state
from security.policy_audit import read_events


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )


@pytest.fixture
def copies(tmp_path: Path) -> tuple[Path, Path, Path]:
    """The project, the card's copy of the spec, and the task worktree's copy."""
    project = tmp_path / "proj"
    main = project / ".workpilot" / "specs" / "001-x"
    worktree = project / ".workpilot" / "worktrees" / "tasks" / "001-x"
    task = worktree / ".workpilot" / "specs" / "001-x"
    main.mkdir(parents=True)
    task.mkdir(parents=True)
    return project, main, task


def test_nothing_stops_a_task_that_runs(copies):
    _project, _main, task = copies
    assert stop_reason(task) is None


def test_a_pause_in_the_card_s_copy_stops_the_swarm(copies):
    _project, main, task = copies
    (main / "pause_state.json").write_text(
        json.dumps({"enabled": True, "reason": "tool_loop"}), encoding="utf-8"
    )
    assert stop_reason(task) == "tool_loop"


def test_a_pause_without_a_reason_is_still_a_pause(copies):
    _project, _main, task = copies
    (task / "pause_state.json").write_text(
        json.dumps({"enabled": True}), encoding="utf-8"
    )
    assert stop_reason(task) == "paused"


def test_outside_the_hours_the_task_is_paused_in_both_copies(copies):
    project, main, task = copies
    hour = (datetime.now(UTC).hour + 2) % 24
    (project / "workpilot.policy.yaml").write_text(
        yaml.safe_dump(
            {
                "schedule": {
                    "timezone": "UTC",
                    "allowed_hours": [f"{hour:02d}:00-{hour:02d}:30"],
                }
            }
        ),
        encoding="utf-8",
    )
    assert stop_reason(task) == "policy_hours"
    assert read_pause_state(task)["reason"] == "policy_hours"
    assert read_pause_state(main)["reason"] == "policy_hours"
    assert read_events(project)[0]["decision"] == "outside_hours"
