"""The goal gate inside the real QA loop: the reviewer's approval is not "done"."""

from __future__ import annotations

import json
import shlex
import sys
import types
from pathlib import Path

import pytest
from goal.spec import GOAL_FILENAME

PY = shlex.quote(sys.executable)
# Exits 0 once the fixer has written `fixed` in the worktree.
GOAL_COMMAND = f"{PY} -c " + shlex.quote(
    "import pathlib, sys; print('checking'); "
    "sys.exit(0 if pathlib.Path('fixed').exists() else 1)"
)


class _Logger:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def log_error(self, message: str, *_args, **_kwargs) -> None:
        self.errors.append(message)

    def __getattr__(self, _name: str):
        return lambda *_args, **_kwargs: None


class _Emitter:
    def __init__(self) -> None:
        self.events: list[str] = []

    def emit(self, event_type: str, _payload: dict | None = None) -> None:
        self.events.append(event_type)


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc) -> None:
        return None


def _approve(spec_dir: Path) -> None:
    plan_file = spec_dir / "implementation_plan.json"
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    signoff = plan.get("qa_signoff") or {}
    plan["qa_signoff"] = {
        "status": "approved",
        "qa_session": signoff.get("qa_session", 0) + 1,
        "issues_found": [],
    }
    plan_file.write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def harness(tmp_path: Path, monkeypatch):
    import qa.loop as loop

    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "0")
    project = tmp_path
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-task"
    spec_dir.mkdir(parents=True)
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"feature": "x", "phases": []}), encoding="utf-8"
    )
    logger = _Logger()
    emitter = _Emitter()
    calls = types.SimpleNamespace(reviewer=0, fixer=[], fix_on_call=1)

    async def reviewer(_client, _project_dir, spec, *_args, **_kwargs):
        calls.reviewer += 1
        _approve(spec)
        return "approved", "ok"

    async def fixer(_client, spec, iteration, _verbose):
        request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
        calls.fixer.append((iteration, request))
        if len(calls.fixer) >= calls.fix_on_call:
            (project / "fixed").write_text("", encoding="utf-8")
        return "fixed", "ok"

    async def no_security_issue(*_args, **_kwargs):
        return True, None, []

    async def no_jev_advice(*_args, **_kwargs):
        return None

    async def architecture(**_kwargs):
        return True, {"violations": []}

    patches = {
        "is_build_complete": lambda _spec: True,
        "is_no_test_project": lambda *_args: False,
        "run_qa_security_scan": no_security_issue,
        "get_task_logger": lambda _spec: logger,
        "emit_phase": lambda *_args, **_kwargs: None,
        "is_linear_enabled": lambda: False,
        "run_visual_qa": lambda *_args: None,
        "write_visual_qa_report": lambda *_args: None,
        "get_phase_model": lambda *_args, **_kwargs: "test-model",
        "get_phase_thinking_budget": lambda *_args, **_kwargs: None,
        "get_phase_provider": lambda *_args, **_kwargs: "anthropic",
        "qa_iteration_cap": lambda _spec: 5,
        "recurring_issue_threshold": lambda _cap: 10,
        "create_agent_client": lambda **_kwargs: _Client(),
        "run_qa_agent_session": reviewer,
        "run_qa_fixer_session": fixer,
    }
    for name, value in patches.items():
        monkeypatch.setattr(loop, name, value)
    monkeypatch.setattr(
        loop.TaskEventEmitter, "from_spec_dir", staticmethod(lambda _spec: emitter)
    )
    import integrations.jev.adapters as jev_adapters
    import integrations.jev.rubrics as jev_rubrics

    monkeypatch.setattr(jev_adapters, "assess_build", no_jev_advice)
    monkeypatch.setattr(jev_rubrics, "advice_text", lambda _outcome: "")
    validator = types.ModuleType("architecture.validator")
    validator.run_architecture_validation = architecture
    validator.write_architecture_fix_request = lambda *_args: None
    package = types.ModuleType("architecture")
    package.validator = validator
    monkeypatch.setitem(sys.modules, "architecture", package)
    monkeypatch.setitem(sys.modules, "architecture.validator", validator)

    def goal(**fields) -> None:
        (spec_dir / GOAL_FILENAME).write_text(
            json.dumps({"command": GOAL_COMMAND, **fields}), encoding="utf-8"
        )

    async def run() -> bool:
        return await loop.run_qa_validation_loop(
            project_dir=project, spec_dir=spec_dir, model="test-model"
        )

    return types.SimpleNamespace(
        run=run,
        goal=goal,
        spec_dir=spec_dir,
        project=project,
        logger=logger,
        emitter=emitter,
        calls=calls,
    )


def _plan(spec_dir: Path) -> dict:
    return json.loads(
        (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )


async def test_an_approval_with_the_goal_unmet_goes_to_the_fixer(harness):
    harness.goal()
    assert await harness.run() is True
    assert harness.calls.reviewer == 2
    [(iteration, request)] = harness.calls.fixer
    assert iteration == 1
    assert "Goal not met" in request
    assert "exit code 1, expected 0" in request
    assert harness.logger.errors[0].startswith("QA pass #1 rejected by the goal gate")
    assert harness.emitter.events[-1] == "QA_PASSED"
    assert _plan(harness.spec_dir)["goal"]["status"] == "met"


async def test_the_goal_buys_its_own_number_of_passes(harness):
    harness.goal(maxRounds=2)
    harness.calls.fix_on_call = 99
    assert await harness.run() is False
    assert harness.calls.reviewer == 2
    assert harness.emitter.events.count("QA_MAX_ITERATIONS") == 1
    assert "QA_PASSED" not in harness.emitter.events
    assert _plan(harness.spec_dir)["goal"]["status"] == "unmet"
    assert _plan(harness.spec_dir)["qa_signoff"]["status"] == "rejected"


async def test_an_unreadable_goal_stops_before_any_review(harness):
    (harness.spec_dir / GOAL_FILENAME).write_text('{"command": 3}', encoding="utf-8")
    assert await harness.run() is False
    assert harness.calls.reviewer == 0
    assert "QA_MAX_ITERATIONS" in harness.emitter.events
    assert _plan(harness.spec_dir)["goal"]["status"] == "invalid"


async def test_a_goal_that_cannot_run_is_a_person_s_call_not_a_fix(harness):
    (harness.spec_dir / GOAL_FILENAME).write_text(
        json.dumps({"command": "no-such-program-for-goal-xyz"}), encoding="utf-8"
    )
    assert await harness.run() is False
    assert harness.calls.reviewer == 1
    assert harness.calls.fixer == []
    assert _plan(harness.spec_dir)["goal"]["status"] == "error"


async def test_the_spending_cap_stops_before_a_pass(harness):
    harness.goal(maxCostUsd=1.0)
    ledger = harness.project / ".workpilot" / "cost_data.json"
    ledger.write_text(
        json.dumps({"usages": [{"spec_id": "001-task", "cost": 1.25}]}),
        encoding="utf-8",
    )
    assert await harness.run() is False
    assert harness.calls.reviewer == 0
    plan = _plan(harness.spec_dir)
    assert plan["goal"]["status"] == "budget"
    assert plan["goal"]["spentUsd"] == 1.25


async def test_an_earlier_approval_does_not_skip_an_unmet_goal(harness):
    _approve(harness.spec_dir)
    harness.goal()
    assert await harness.run() is True
    # Not the "already approved" shortcut: the loop ran, fixed, re-checked.
    assert harness.calls.reviewer == 2
    assert len(harness.calls.fixer) == 1


async def test_an_earlier_approval_with_the_goal_met_still_short_circuits(harness):
    _approve(harness.spec_dir)
    (harness.project / "fixed").write_text("", encoding="utf-8")
    harness.goal()
    assert await harness.run() is True
    assert harness.calls.reviewer == 0


async def test_without_a_goal_nothing_changes(harness):
    assert await harness.run() is True
    assert harness.calls.reviewer == 1
    assert "goal" not in _plan(harness.spec_dir)


def test_a_build_that_skips_qa_still_answers_to_the_goal(tmp_path: Path):
    from cli.build_commands import _goal_allows_done

    spec_dir = tmp_path / ".workpilot" / "specs" / "001-task"
    spec_dir.mkdir(parents=True)
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    assert _goal_allows_done(tmp_path, spec_dir, None) is True
    (spec_dir / GOAL_FILENAME).write_text(
        json.dumps({"command": GOAL_COMMAND}), encoding="utf-8"
    )
    assert _goal_allows_done(tmp_path, spec_dir, None) is False
    (tmp_path / "fixed").write_text("", encoding="utf-8")
    assert _goal_allows_done(tmp_path, spec_dir, None) is True
    (spec_dir / GOAL_FILENAME).write_text("[]", encoding="utf-8")
    assert _goal_allows_done(tmp_path, spec_dir, None) is False
