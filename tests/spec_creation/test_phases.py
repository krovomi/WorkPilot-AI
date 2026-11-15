"""Each spec phase on its own: what it writes, what it stands in when its
agent writes nothing, how it retries and when it gives up."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import ui
from spec.phases import PhaseExecutor
from spec.validate_pkg import SpecValidator
from task_logger import TaskLogger

VALID_SPEC = """# Specification

## Overview

Export invoices as CSV.

## Workflow Type

feature

## Task Scope

The invoices page.

## Requirements

- FR-001: one row per invoice.

## Success Criteria

1. [ ] One row per invoice.
"""

VALID_PLAN = {
    "feature": "Export invoices",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "1",
            "name": "Export",
            "subtasks": [
                {"id": "1.1", "description": "CSV writer", "status": "pending"}
            ],
        }
    ],
}


class Agent:
    """Plays the agent sessions: each answer is a callable run on the spec dir."""

    def __init__(self, spec_dir: Path, *answers):
        self.spec_dir = spec_dir
        self.answers = list(answers)
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, prompt_file, additional_context="", phase_name=None, **kw):
        self.calls.append((prompt_file, additional_context))
        answer = self.answers.pop(0) if self.answers else None
        if answer is None:
            return False, "agent failed"
        answer(self.spec_dir)
        return True, "done"


def write(name: str, content):
    def run(spec_dir: Path) -> None:
        text = content if isinstance(content, str) else json.dumps(content)
        (spec_dir / name).write_text(text, encoding="utf-8")

    return run


def nothing(spec_dir: Path) -> None:
    """The session succeeds and writes nothing."""


def both(*steps):
    def run(spec_dir: Path) -> None:
        for step in steps:
            step(spec_dir)

    return run


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    path = tmp_path / "app" / ".workpilot" / "specs" / "001-export"
    path.mkdir(parents=True)
    return path


def executor(
    spec_dir: Path, agent=None, task="Export invoices as CSV"
) -> PhaseExecutor:
    return PhaseExecutor(
        project_dir=spec_dir.parents[2],
        spec_dir=spec_dir,
        task_description=task,
        spec_validator=SpecValidator(spec_dir),
        run_agent_fn=agent or Agent(spec_dir),
        task_logger=TaskLogger(spec_dir, emit_markers=False),
        ui_module=ui,
    )


# --- discovery and context -------------------------------------------------


async def test_discovery_retries_then_reports_every_attempt(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from spec import discovery

    monkeypatch.setattr(discovery, "run_discovery_script", lambda *a: (False, "boom"))

    result = await executor(spec_dir).phase_discovery()

    assert not result.success
    assert result.errors == ["Attempt 1: boom", "Attempt 2: boom", "Attempt 3: boom"]


async def test_discovery_copies_the_project_index(spec_dir: Path) -> None:
    index = spec_dir.parents[1] / "project_index.json"
    index.write_text(json.dumps({"files": ["a.py", "b.py"]}), encoding="utf-8")

    result = await executor(spec_dir).phase_discovery()

    assert result.success
    assert json.loads((spec_dir / "project_index.json").read_text("utf-8"))["files"]


async def test_an_existing_context_is_kept(spec_dir: Path) -> None:
    (spec_dir / "context.json").write_text(
        '{"task_description": "x"}', encoding="utf-8"
    )

    result = await executor(spec_dir).phase_context()

    assert result.success and result.retries == 0


async def test_the_context_comes_from_the_task_itself(
    spec_dir: Path,
) -> None:
    (spec_dir / "requirements.json").write_text(
        json.dumps(
            {
                "task_description": "Fix `Controllers/InvoiceController.cs` and Startup.cs.",
                "services_involved": ["api"],
            }
        ),
        encoding="utf-8",
    )

    result = await executor(spec_dir).phase_context()

    assert result.success and result.errors == []
    context = json.loads((spec_dir / "context.json").read_text("utf-8"))
    assert context["files_to_modify"] == [
        "Controllers/InvoiceController.cs",
        "Startup.cs",
    ]
    assert context["scoped_services"] == ["api"]


# --- requirements, historical context, research -----------------------------


async def test_requirements_come_from_the_task_when_not_interactive(spec_dir) -> None:
    long_task = "Export invoices " * 10

    result = await executor(spec_dir, task=long_task).phase_requirements(False)

    assert result.success
    saved = json.loads((spec_dir / "requirements.json").read_text("utf-8"))
    assert saved["task_description"] == long_task


async def test_requirements_already_written_are_kept(spec_dir) -> None:
    (spec_dir / "requirements.json").write_text("{}", encoding="utf-8")

    assert (await executor(spec_dir).phase_requirements(False)).success


async def test_requirements_without_a_task_get_a_placeholder(spec_dir) -> None:
    result = await executor(spec_dir, task=None).phase_requirements(False)

    assert result.success
    saved = json.loads((spec_dir / "requirements.json").read_text("utf-8"))
    assert saved["task_description"] == "Unknown task"


async def test_requirements_gathered_interactively(spec_dir, monkeypatch) -> None:
    answers = iter(["Add a dark mode", "", "2", "Keep the contrast AA", ""])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    phases = executor(spec_dir, task=None)

    result = await phases.phase_requirements(True)

    assert result.success
    assert phases.task_description == "Add a dark mode"
    saved = json.loads((spec_dir / "requirements.json").read_text("utf-8"))
    assert saved["workflow_type"] == "bugfix"
    assert saved["additional_context"] == "Keep the contrast AA"


async def test_historical_context_already_retrieved(spec_dir) -> None:
    (spec_dir / "graph_hints.json").write_text("{}", encoding="utf-8")

    assert (await executor(spec_dir).phase_historical_context()).success


async def test_historical_context_with_memory_off(spec_dir, monkeypatch) -> None:
    monkeypatch.setenv("BRAIN_ENABLED", "false")

    result = await executor(spec_dir).phase_historical_context()

    assert result.success
    assert (
        json.loads((spec_dir / "graph_hints.json").read_text("utf-8"))["enabled"]
        is False
    )


@pytest.mark.parametrize(
    ("hints", "error"),
    [([{"insight": "use the CSV helper"}], None), ([], None), (None, "graph down")],
)
async def test_historical_context_queries_the_brain(
    spec_dir, monkeypatch, hints, error
) -> None:
    seen = {}

    async def get_graph_hints(query, project_id, max_results, spec_dir):
        seen["query"] = query
        if error:
            raise RuntimeError(error)
        return hints

    monkeypatch.setattr("memory.store.is_memory_enabled", lambda: True)
    monkeypatch.setattr("memory.store.get_graph_hints", get_graph_hints)
    (spec_dir / "requirements.json").write_text(
        json.dumps({"task_description": "Export the invoices"}), encoding="utf-8"
    )

    result = await executor(spec_dir).phase_historical_context()

    assert result.success
    assert seen["query"] == "Export the invoices"
    saved = json.loads((spec_dir / "graph_hints.json").read_text("utf-8"))
    if error:
        assert result.errors == [error]
    else:
        assert saved["hint_count"] == len(hints)


async def test_historical_context_without_a_task(spec_dir, monkeypatch) -> None:
    monkeypatch.setattr("memory.store.is_memory_enabled", lambda: True)

    result = await executor(spec_dir, task="").phase_historical_context()

    assert result.success
    saved = json.loads((spec_dir / "graph_hints.json").read_text("utf-8"))
    assert saved["enabled"] is True and saved["hints"] == []


async def test_research_without_requirements_is_skipped(spec_dir) -> None:
    result = await executor(spec_dir).phase_research()

    assert result.success and (spec_dir / "research.json").is_file()


async def test_research_done_by_the_agent_is_kept(spec_dir) -> None:
    (spec_dir / "requirements.json").write_text("{}", encoding="utf-8")
    agent = Agent(spec_dir, write("research.json", {"integrations": []}))

    result = await executor(spec_dir, agent).phase_research()

    assert result.success and not result.warnings
    assert agent.calls[0][0] == "spec_researcher.md"
    # A real research.json is not redone.
    assert (await executor(spec_dir, Agent(spec_dir)).phase_research()).success


async def test_research_the_agent_never_wrote_is_a_placeholder(spec_dir) -> None:
    (spec_dir / "requirements.json").write_text("{}", encoding="utf-8")

    result = await executor(spec_dir, Agent(spec_dir, nothing)).phase_research()

    assert result.success
    assert result.warnings == [
        "research.json is a placeholder: Agent completed but created no findings"
    ]


async def test_research_that_keeps_failing_is_a_placeholder(spec_dir) -> None:
    (spec_dir / "requirements.json").write_text("{}", encoding="utf-8")

    result = await executor(spec_dir, Agent(spec_dir)).phase_research()

    assert result.success and len(result.errors) == 3
    assert "Research agent failed after retries" in result.warnings[0]


# --- quick spec, spec writing, self-critique --------------------------------


async def test_quick_spec_already_written(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    write("implementation_plan.json", VALID_PLAN)(spec_dir)

    assert (await executor(spec_dir).phase_quick_spec()).success


async def test_quick_spec_without_a_plan_gets_a_valid_stand_in(spec_dir) -> None:
    agent = Agent(spec_dir, write("spec.md", VALID_SPEC))

    result = await executor(spec_dir, agent).phase_quick_spec()

    assert result.success
    assert "minimal stand-in" in result.warnings[0]
    # The stand-in passes the plan checkpoint it is written for.
    assert SpecValidator(spec_dir).validate_implementation_plan().valid


async def test_a_failing_quick_spec_escalates_to_the_standard_phases(spec_dir) -> None:
    agent = Agent(
        spec_dir,
        None,
        None,
        None,
        write("spec.md", VALID_SPEC),
        write("implementation_plan.json", VALID_PLAN),
    )

    result = await executor(spec_dir, agent).phase_quick_spec()

    assert result.success
    assert [c[0] for c in agent.calls] == [
        "spec_quick.md",
        "spec_quick.md",
        "spec_quick.md",
        "spec_writer.md",
        "planner.md",
    ]
    assert "Attempt 1: Quick spec agent failed" in result.errors


async def test_an_escalation_whose_planning_fails_fails_the_quick_spec(
    spec_dir,
) -> None:
    agent = Agent(spec_dir, None, None, None, write("spec.md", VALID_SPEC))

    result = await executor(spec_dir, agent).phase_quick_spec()

    assert not result.success
    assert any("Did not create plan file" in e for e in result.errors)


async def test_an_escalation_that_leaves_no_plan_fails(spec_dir, monkeypatch) -> None:
    from spec.phases.models import PhaseResult

    phases = executor(spec_dir, Agent(spec_dir))

    async def ok(name):
        return PhaseResult(name, True, [], [], 0)

    monkeypatch.setattr(phases, "phase_context", lambda: ok("context"))
    monkeypatch.setattr(phases, "phase_spec_writing", lambda: ok("spec_writing"))
    monkeypatch.setattr(phases, "phase_planning", lambda: ok("planning"))

    result = await phases.phase_quick_spec()

    assert not result.success
    assert result.errors[-1].startswith("Escalation completed but")


async def test_a_valid_spec_is_not_rewritten(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    agent = Agent(spec_dir)

    assert (await executor(spec_dir, agent).phase_spec_writing()).success
    assert agent.calls == []


async def test_an_invalid_spec_is_rewritten_with_the_minimal_context_note(
    spec_dir,
) -> None:
    write("spec.md", "# too short")(spec_dir)
    write(
        "context.json",
        {"task_description": "Export", "fallback_mode": True, "files_to_modify": []},
    )(spec_dir)
    agent = Agent(
        spec_dir, write("spec.md", "# still short"), write("spec.md", VALID_SPEC)
    )

    result = await executor(spec_dir, agent).phase_spec_writing()

    assert result.success and result.retries == 1
    assert "minimal context" in agent.calls[0][1]


async def test_a_spec_the_writer_never_gets_right_fails(spec_dir) -> None:
    agent = Agent(spec_dir, *[write("spec.md", "# short")] * 3)

    result = await executor(spec_dir, agent).phase_spec_writing()

    assert not result.success and len(result.errors) == 3


async def test_a_writer_that_writes_nothing_gets_a_valid_stack_neutral_fallback(
    spec_dir,
) -> None:
    write(
        "requirements.json",
        {"task_description": "Add an endpoint " * 5, "workflow_type": "feature"},
    )(spec_dir)
    write("context.json", "{not json")(spec_dir)

    result = await executor(spec_dir, Agent(spec_dir)).phase_spec_writing()

    assert result.success and result.errors == ["Created fallback spec"]
    text = (spec_dir / "spec.md").read_text("utf-8")
    assert SpecValidator(spec_dir).validate_spec_document().valid
    assert "python" not in text.lower()


async def test_a_fallback_spec_survives_unreadable_requirements(spec_dir) -> None:
    write("requirements.json", "{not json")(spec_dir)

    result = await executor(spec_dir, Agent(spec_dir)).phase_spec_writing()

    assert result.success
    assert "Unknown task" in (spec_dir / "spec.md").read_text("utf-8")


async def test_self_critique_needs_a_spec(spec_dir) -> None:
    assert not (await executor(spec_dir).phase_self_critique()).success


@pytest.mark.parametrize(
    "report", ['{"issues_fixed": true}', '{"no_issues_found": true}']
)
async def test_a_finished_critique_is_not_redone(spec_dir, report) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    write("critique_report.json", report)(spec_dir)
    agent = Agent(spec_dir)

    assert (await executor(spec_dir, agent).phase_self_critique()).success
    assert agent.calls == []


async def test_an_unreadable_critique_is_redone(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    write("critique_report.json", "{oops")(spec_dir)
    agent = Agent(spec_dir, write("critique_report.json", {"issues_fixed": True}))

    result = await executor(spec_dir, agent).phase_self_critique()

    assert result.success and not result.warnings
    assert agent.calls[0][0] == "spec_critic.md"


async def test_a_critic_that_writes_no_report_leaves_a_placeholder(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)

    result = await executor(spec_dir, Agent(spec_dir, nothing)).phase_self_critique()

    assert result.success
    assert result.warnings[0].startswith("critique_report.json is a placeholder")


async def test_a_critique_that_breaks_the_spec_is_retried_then_stood_in(
    spec_dir,
) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    agent = Agent(spec_dir, write("spec.md", "# broken"), None, None)

    result = await executor(spec_dir, agent).phase_self_critique()

    assert result.success
    assert result.errors == [
        "Attempt 1: Spec still invalid after critique",
        "Attempt 2: Critique agent failed",
        "Attempt 3: Critique agent failed",
    ]


# --- planning and validation --------------------------------------------------


async def test_a_valid_plan_is_kept(spec_dir) -> None:
    write("implementation_plan.json", VALID_PLAN)(spec_dir)

    assert (await executor(spec_dir).phase_planning()).success


async def test_planning_needs_a_spec(spec_dir) -> None:
    write("implementation_plan.json", {"status": "backlog"})(spec_dir)

    result = await executor(spec_dir).phase_planning()

    assert not result.success
    # The status-only stub the frontend writes is removed first.
    assert not (spec_dir / "implementation_plan.json").exists()


async def test_a_planner_plan_with_missing_fields_is_auto_fixed(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    plan = {"phases": [{"name": "Export", "subtasks": [{"description": "CSV writer"}]}]}
    agent = Agent(spec_dir, write("implementation_plan.json", plan))

    result = await executor(spec_dir, agent).phase_planning()

    assert result.success
    fixed = json.loads((spec_dir / "implementation_plan.json").read_text("utf-8"))
    assert fixed["phases"][0]["subtasks"][0]["status"] == "pending"


async def test_a_plan_written_at_the_project_root_is_moved_into_the_spec(
    spec_dir,
) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    root = spec_dir.parents[2]

    def at_root(_spec_dir):
        (root / "implementation_plan.json").write_text(
            json.dumps(VALID_PLAN), encoding="utf-8"
        )

    result = await executor(spec_dir, Agent(spec_dir, at_root)).phase_planning()

    assert result.success
    assert not (root / "implementation_plan.json").exists()
    assert (spec_dir / "implementation_plan.json").is_file()


async def test_a_misplaced_plan_with_missing_fields_is_moved_and_fixed(
    spec_dir,
) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    root = spec_dir.parents[2]
    plan = {"phases": [{"name": "Export", "subtasks": [{"description": "CSV"}]}]}

    def at_root(_spec_dir):
        (root / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )

    assert (await executor(spec_dir, Agent(spec_dir, at_root)).phase_planning()).success


async def test_planning_gives_up_after_three_bad_plans(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    root = spec_dir.parents[2]

    def unfixable_at_root(_spec_dir):
        (root / "implementation_plan.json").write_text(
            '"just a string"', encoding="utf-8"
        )

    agent = Agent(
        spec_dir,
        write("implementation_plan.json", "[]"),
        unfixable_at_root,
        None,
    )

    result = await executor(spec_dir, agent).phase_planning()

    assert not result.success
    assert result.errors[0].startswith("Agent attempt 1: [")
    assert "Plan at wrong path and invalid" in result.errors[1]
    assert "agent error" in result.errors[2]


async def test_validation_passes_a_complete_spec(spec_dir) -> None:
    write("project_index.json", {"project_type": "single"})(spec_dir)
    write("context.json", {"task_description": "x", "files_to_modify": ["a.ts"]})(
        spec_dir
    )
    write("spec.md", VALID_SPEC)(spec_dir)
    write("implementation_plan.json", VALID_PLAN)(spec_dir)

    result = await executor(spec_dir).phase_validation()

    assert result.success and result.retries == 0


async def test_validation_asks_the_fixer_then_fails_with_every_error(spec_dir) -> None:
    write("spec.md", VALID_SPEC)(spec_dir)
    agent = Agent(spec_dir, write("context.json", {"task_description": "x"}), None)

    result = await executor(spec_dir, agent).phase_validation()

    assert not result.success
    assert [c[0] for c in agent.calls] == ["validation_fixer.md", "validation_fixer.md"]
    assert "**context** validation failed:" in agent.calls[0][1]
    assert "prereqs: project_index.json not found" in result.errors
    assert "plan: implementation_plan.json not found" in result.errors
