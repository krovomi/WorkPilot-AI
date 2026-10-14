"""A gate that overturns the reviewer's approval sends the pass to the fixer.

The architecture and coverage gates run inside the reviewer's "approved"
branch and turn the status into "rejected". The rejection handler was the
`elif` of that branch, so it never ran for them: no fixer, the next pass
re-reviewed the same code, and the log promised a fix and a pass that never
came before the task landed in human review.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest


class _Logger:
    """Task logger double: keeps the error lines, ignores the rest."""

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
    """What the reviewer writes: approved, with no coverage recorded."""
    plan_file = spec_dir / "implementation_plan.json"
    plan = json.loads(plan_file.read_text(encoding="utf-8"))
    signoff = plan.get("qa_signoff") or {}
    plan["qa_signoff"] = {
        "status": "approved",
        "qa_session": signoff.get("qa_session", 0) + 1,
        "issues_found": [],
        "tests_passed": {"unit": "12/12"},
    }
    plan_file.write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def harness(tmp_path: Path, monkeypatch):
    """The real loop, with every agent and side channel replaced."""
    import qa.loop as loop

    spec_dir = tmp_path / "001-task"
    spec_dir.mkdir()
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"feature": "x", "phases": []}), encoding="utf-8"
    )

    logger = _Logger()
    emitter = _Emitter()
    fixer_calls: list[tuple[int, str]] = []

    async def reviewer(_client, _project_dir, spec, *_args, **_kwargs):
        _approve(spec)
        return "approved", "ok"

    async def fixer(_client, spec, iteration, _verbose):
        request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
        fixer_calls.append((iteration, request))
        return "fixed", "ok"

    async def no_security_issue(*_args, **_kwargs):
        return True, None, []

    async def no_jev_advice(*_args, **_kwargs):
        return None

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
        "qa_iteration_cap": lambda _spec: 3,
        # Above the cap: the budget, not the recurring-issue escalation, ends
        # the loop here.
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

    arch_results: list[tuple[bool, dict]] = []

    async def architecture(**_kwargs):
        return arch_results.pop(0) if arch_results else (True, {"violations": []})

    def write_architecture_fix_request(spec: Path, _report: dict) -> None:
        (spec / "QA_FIX_REQUEST.md").write_text(
            "# Architecture fix request", encoding="utf-8"
        )

    validator = types.ModuleType("architecture.validator")
    validator.run_architecture_validation = architecture
    validator.write_architecture_fix_request = write_architecture_fix_request
    package = types.ModuleType("architecture")
    package.validator = validator
    monkeypatch.setitem(sys.modules, "architecture", package)
    monkeypatch.setitem(sys.modules, "architecture.validator", validator)

    async def run() -> bool:
        return await loop.run_qa_validation_loop(
            project_dir=tmp_path, spec_dir=spec_dir, model="test-model"
        )

    return types.SimpleNamespace(
        run=run,
        spec_dir=spec_dir,
        logger=logger,
        emitter=emitter,
        fixer_calls=fixer_calls,
        arch_results=arch_results,
    )


def _history(spec_dir: Path) -> list[dict]:
    plan = json.loads(
        (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )
    return plan.get("qa_iteration_history", [])


async def test_a_coverage_rejection_runs_the_fixer(harness, monkeypatch):
    monkeypatch.delenv("WORKPILOT_QA_MIN_COVERAGE", raising=False)

    assert await harness.run() is False

    # One fix after each rejected pass but the last, on the gate's own request.
    assert [iteration for iteration, _ in harness.fixer_calls] == [1, 2]
    assert all("Couverture de tests" in request for _, request in harness.fixer_calls)
    assert harness.logger.errors == [
        "QA pass #1 rejected by the coverage gate; applying a fix, then "
        "re-reviewing (pass #2).",
        "QA pass #2 rejected by the coverage gate; applying a fix, then "
        "re-reviewing (pass #3).",
        "QA pass #3 rejected by the coverage gate; handing over to human review.",
    ]
    # One verdict per pass: a second QA_FAILED while the card is in
    # qa_fixing moves it to human review in the middle of the loop.
    assert harness.emitter.events.count("QA_FAILED") == 3
    assert harness.emitter.events.count("QA_FIXING_STARTED") == 2
    assert harness.emitter.events.count("QA_MAX_ITERATIONS") == 1
    rejected = [r for r in _history(harness.spec_dir) if r["status"] == "rejected"]
    assert [r["iteration"] for r in rejected] == [1, 2, 3]


async def test_an_architecture_rejection_runs_the_fixer(harness, monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "0")
    harness.arch_results.append(
        (
            False,
            {
                "violations": [
                    {"type": "layer", "description": "Domain imports Infrastructure"}
                ]
            },
        )
    )

    assert await harness.run() is True

    assert harness.fixer_calls == [(1, "# Architecture fix request")]
    assert harness.logger.errors == [
        "QA pass #1 rejected: 1 architecture violation(s); applying a fix, then "
        "re-reviewing (pass #2).",
    ]
    assert harness.emitter.events.count("QA_FAILED") == 1
    assert harness.emitter.events[-1] == "QA_PASSED"
