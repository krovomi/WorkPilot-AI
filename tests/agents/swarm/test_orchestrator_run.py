"""A swarm run, from the plan to its last wave.

The plan is a real ``implementation_plan.json``; each subtask is a real
process of the backend stand-in from ``conftest.py``. The project here is not
a git checkout, so the subtasks run in it and nothing is merged (the
worktrees and the merge: ``test_swarm_worktrees.py``). What the orchestrator
reports is read from its status and from the ``__SWARM_EVENT__`` lines the
app parses.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from agents.swarm.orchestrator import SwarmOrchestrator
from agents.swarm.types import SubtaskState, SwarmConfig, SwarmPhase
from agents.swarm.wave_executor import SWARM_EVENT_PREFIX


def _events(out: str) -> list[dict]:
    return [
        json.loads(line[len(SWARM_EVENT_PREFIX) :])
        for line in out.splitlines()
        if line.startswith(SWARM_EVENT_PREFIX)
    ]


def _write_plan(world: dict[str, Path], plan: object) -> None:
    (world["spec"] / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def _steps(world: dict[str, Path], **steps: list[str]) -> None:
    (world["project"] / "swarm_plan.json").write_text(
        json.dumps(steps), encoding="utf-8"
    )


def _attempts(world: dict[str, Path], subtask: str) -> int:
    counter = world["project"] / "attempts" / subtask
    return int(counter.read_text(encoding="utf-8")) if counter.exists() else 0


def _swarm(world: dict[str, Path], **config: object) -> SwarmOrchestrator:
    return SwarmOrchestrator(
        project_dir=world["project"],
        spec_dir=world["spec"],
        config=SwarmConfig(subtask_timeout_seconds=60, **config),  # type: ignore[arg-type]
        python_path=sys.executable,
        source_path=str(world["source"]),
    )


CART_PLAN = {
    "phases": [
        {
            "name": "Backend",
            "subtasks": [
                {"id": "api", "description": "cart API", "files_to_create": ["api.py"]},
                {"id": "db", "description": "cart table", "files_to_create": ["db.py"]},
                {"id": "done", "description": "already there", "status": "completed"},
            ],
        },
        {
            "name": "Frontend",
            "subtasks": [{"id": "ui", "description": "cart page"}],
        },
    ]
}


def test_two_waves_run_and_a_failed_subtask_is_retried(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plan(world, CART_PLAN)
    _steps(world, api=["ok"], db=["fail", "ok"], ui=["ok"])
    swarm = _swarm(world)

    status = asyncio.run(swarm.run())

    assert status.phase is SwarmPhase.COMPLETE
    assert (status.total_subtasks, status.total_waves) == (3, 2)
    assert (status.completed_subtasks, status.failed_subtasks) == (3, 0)
    assert [w.subtask_ids for w in status.waves] == [["api", "db"], ["ui"]]
    # The retry's success replaces the failure, so the wave merge sees it.
    assert [w.state for w in status.waves] == [
        SubtaskState.COMPLETED,
        SubtaskState.COMPLETED,
    ]
    # Outside a git checkout there is nothing to merge.
    assert [w.merge_success for w in status.waves] == [None, None]
    assert (_attempts(world, "db"), _attempts(world, "api")) == (2, 1)
    assert status.nodes["db"].state is SubtaskState.COMPLETED
    assert status.is_complete and status.progress_percent == 100

    events = _events(capsys.readouterr().out)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "phase_changed"
    analysis = events[kinds.index("analysis_complete")]
    assert analysis["parallelism_stats"]["wave_sizes"] == [2, 1]
    assert {
        "type": "subtask_retrying",
        "subtask_id": "db",
        "attempt": 1,
        "max_retries": 2,
    } in events
    assert "swarm_skipped" not in kinds
    assert "wave_merged" not in kinds
    assert events[-1]["type"] == "swarm_complete"
    assert (events[-1]["completed"], events[-1]["failed"]) == (3, 0)


def test_a_subtask_that_keeps_failing_is_retried_as_often_as_configured(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plan(world, {"phases": [{"name": "p", "subtasks": [{"id": "flaky"}]}]})
    _steps(world, flaky=["silent"])

    status = asyncio.run(_swarm(world, max_retries_per_subtask=3).run())

    # One run and three retries, then the swarm carries on without it.
    assert _attempts(world, "flaky") == 4
    assert status.nodes["flaky"].retry_count == 3
    assert (status.completed_subtasks, status.failed_subtasks) == (0, 1)
    assert status.waves[0].state is SubtaskState.FAILED
    retries = [
        e["attempt"]
        for e in _events(capsys.readouterr().out)
        if e["type"] == "subtask_retrying"
    ]
    assert retries == [1, 2, 3]


def test_fail_fast_stops_at_the_first_failed_wave(world: dict[str, Path]) -> None:
    _write_plan(world, CART_PLAN)
    _steps(world, api=["ok"], db=["silent"], ui=["ok"])

    status = asyncio.run(_swarm(world, fail_fast=True).run())

    assert status.phase is SwarmPhase.FAILED
    assert status.error == "Wave 0 failed (fail_fast=true): db"
    assert status.completed_at is not None
    assert _attempts(world, "db") == 1
    assert _attempts(world, "ui") == 0


def test_a_plan_with_no_parallelism_still_runs_in_order(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plan(
        world,
        {
            "phases": [
                {"name": "one", "subtasks": [{"id": "first"}]},
                {"name": "two", "subtasks": [{"id": "second"}]},
            ]
        },
    )
    _steps(world, first=["ok"], second=["ok"])

    status = asyncio.run(_swarm(world).run())

    assert status.phase is SwarmPhase.COMPLETE
    events = _events(capsys.readouterr().out)
    [skipped] = [e for e in events if e["type"] == "swarm_skipped"]
    assert skipped["reason"] == "no_parallelism"


def test_a_plan_whose_subtasks_are_all_done_completes_with_nothing_to_run(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plan(
        world,
        {"phases": [{"name": "p", "subtasks": [{"id": "a", "status": "completed"}]}]},
    )

    status = asyncio.run(_swarm(world).run())

    # It used to fail with KeyError('total_subtasks'): the stats of no wave
    # lacked the keys the run logs.
    assert status.phase is SwarmPhase.COMPLETE
    assert status.error is None
    assert (status.total_subtasks, status.total_waves) == (0, 0)
    [analysis] = [
        e for e in _events(capsys.readouterr().out) if e["type"] == "analysis_complete"
    ]
    assert analysis["parallelism_stats"]["speedup_estimate"] == 1.0


def test_a_plan_it_cannot_read_fails_the_swarm(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _write_plan(world, ["not", "a", "plan"])

    status = asyncio.run(_swarm(world).run())

    assert status.phase is SwarmPhase.FAILED
    assert "'list' object has no attribute 'get'" in (status.error or "")
    [failed] = [
        e for e in _events(capsys.readouterr().out) if e["type"] == "swarm_failed"
    ]
    assert failed["error"] == status.error


def test_cancelling_the_swarm_marks_it_failed(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    swarm = _swarm(world)

    asyncio.run(swarm.cancel())

    assert swarm.status.phase is SwarmPhase.FAILED
    assert swarm.status.error == "Cancelled by user"
    assert [e["type"] for e in _events(capsys.readouterr().out)] == ["swarm_cancelled"]
