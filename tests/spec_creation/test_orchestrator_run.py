"""SpecOrchestrator.run, end to end, with a stand-in for the agent sessions.

Everything but the model is real: the project index, discovery, requirements,
the folder rename, the complexity verdict, each phase's files, the validators
and the review checkpoint. The stand-in writes what each prompt asks its agent
to write.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from spec.pipeline import orchestrator as orchestrator_module
from spec.pipeline.orchestrator import SpecOrchestrator

SPEC_MD = """# Specification: export invoices

## Overview

Export the invoices of a month as a CSV file from the invoices page.

## Workflow Type

**Type**: feature

## Task Scope

- Add an export button and a CSV writer.

## Requirements

- FR-001: The export holds one row per invoice.

## Success Criteria

1. [ ] The CSV opens in a spreadsheet with one row per invoice.
"""

PLAN = {
    "feature": "Export invoices",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "phase-1",
            "name": "Export",
            "subtasks": [
                {
                    "id": "1.1",
                    "description": "Write the CSV exporter",
                    "status": "pending",
                }
            ],
        }
    ],
}


class ScriptedRunner:
    """Answers each prompt by writing the files its agent is asked for."""

    def __init__(self, orchestrator: SpecOrchestrator, fail: set[str] = frozenset()):
        self.orchestrator = orchestrator
        self.fail = set(fail)
        self.calls: list[tuple[str, str | None]] = []

    async def run_agent(
        self,
        prompt_file,
        additional_context="",
        interactive=False,
        thinking_budget=None,
        prior_phase_summaries=None,
    ):
        self.calls.append((prompt_file, prior_phase_summaries))
        if prompt_file in self.fail:
            return False, "the session failed"
        spec_dir = self.orchestrator.spec_dir
        if prompt_file in ("spec_quick.md", "spec_writer.md"):
            (spec_dir / "spec.md").write_text(SPEC_MD, encoding="utf-8")
        if prompt_file in ("spec_quick.md", "planner.md"):
            (spec_dir / "implementation_plan.json").write_text(
                json.dumps(PLAN), encoding="utf-8"
            )
        if prompt_file == "validation_fixer.md":
            (spec_dir / "context.json").write_text(
                json.dumps(
                    {
                        "task_description": "Export invoices",
                        "files_to_modify": ["src/invoices/export.ts"],
                        "files_to_reference": [],
                        "scoped_services": ["web"],
                    }
                ),
                encoding="utf-8",
            )
        return True, f"{prompt_file} done"


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"express": "^4"}}),
        encoding="utf-8",
    )
    (root / "src" / "index.ts").write_text("export const x = 1;\n", encoding="utf-8")
    monkeypatch.setenv("BRAIN_ENABLED", "false")

    async def summarize(phase_name, phase_output, **kwargs):
        return f"summary of {phase_name}"

    monkeypatch.setattr(orchestrator_module, "summarize_phase_output", summarize)
    return root


async def test_a_new_spec_is_named_after_its_task_and_every_phase_writes_there(
    project: Path,
) -> None:
    orch = SpecOrchestrator(
        project_dir=project,
        task_description="Export the monthly invoices as CSV",
        complexity_override="simple",
        use_ai_assessment=False,
    )
    assert orch.spec_dir.name == "001-pending"
    runner = ScriptedRunner(orch)
    orch._agent_runner = runner

    assert await orch.run(interactive=False, auto_approve=True) is True

    specs = project / ".workpilot" / "specs"
    assert [p.name for p in specs.iterdir()] == ["001-export-monthly-invoices-csv"]
    assert orch.spec_dir == specs / "001-export-monthly-invoices-csv"
    for name in (
        "requirements.json",
        "project_index.json",
        "complexity_assessment.json",
        "graph_hints.json",
        "spec.md",
        "implementation_plan.json",
        "context.json",
        "review_state.json",
    ):
        assert (orch.spec_dir / name).is_file(), name

    # SIMPLE: quick spec, then validation, which writes the missing
    # context.json itself (no fixer session); the summaries of the earlier
    # phases reached the quick spec.
    assert [call[0] for call in runner.calls] == ["spec_quick.md"]
    assert "summary of discovery" in runner.calls[0][1]
    assert "summary of requirements" in runner.calls[0][1]
    assert json.loads((orch.spec_dir / "review_state.json").read_text("utf-8"))[
        "approved"
    ]


def _events(out: str) -> list[dict]:
    prefix = "__TASK_EVENT__:"
    return [
        json.loads(line[len(prefix) :])
        for line in out.splitlines()
        if line.startswith(prefix)
    ]


def _orchestrator(project: Path, **kwargs) -> SpecOrchestrator:
    kwargs.setdefault("task_description", "Export the monthly invoices as CSV")
    kwargs.setdefault("spec_name", "001-export")
    kwargs.setdefault("use_ai_assessment", False)
    return SpecOrchestrator(project_dir=project, **kwargs)


async def test_a_standard_spec_runs_every_phase_and_reads_review_settings(
    project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    orch = _orchestrator(project, complexity_override="standard")
    (orch.spec_dir / "task_metadata.json").write_text(
        json.dumps({"requireReviewBeforeCoding": True}), encoding="utf-8"
    )
    runner = ScriptedRunner(orch)
    orch._agent_runner = runner

    assert await orch.run(interactive=False, auto_approve=True) is True

    assert [c[0] for c in runner.calls] == ["spec_writer.md", "planner.md"]
    # A named spec keeps its name.
    assert orch.spec_dir.name == "001-export"
    complete = [
        e for e in _events(capsys.readouterr().out) if e["type"] == "PLANNING_COMPLETE"
    ]
    assert complete[0]["requireReviewBeforeCoding"] is True
    # context.json is the minimal one: the context script does not exist.
    context = json.loads((orch.spec_dir / "context.json").read_text("utf-8"))
    assert context["fallback_mode"] is True


async def test_a_failed_phase_stops_the_spec_and_says_which(
    project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    orch = _orchestrator(project, complexity_override="standard")
    orch._agent_runner = ScriptedRunner(orch, fail={"planner.md"})

    assert await orch.run(interactive=False, auto_approve=True) is False

    failed = [
        e for e in _events(capsys.readouterr().out) if e["type"] == "PLANNING_FAILED"
    ]
    assert "planning" in failed[0]["error"]
    assert "Agent attempt 3" in failed[0]["error"]
    assert not (orch.spec_dir / "review_state.json").exists()


async def test_discovery_failure_stops_before_requirements(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from spec import discovery

    monkeypatch.setattr(
        discovery, "run_discovery_script", lambda *a: (False, "analyzer crashed")
    )
    orch = _orchestrator(project, complexity_override="simple")
    orch._agent_runner = ScriptedRunner(orch)

    assert await orch.run(interactive=False, auto_approve=True) is False
    assert not (orch.spec_dir / "requirements.json").exists()


async def test_cancelled_requirements_stop_the_spec(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_more_input(prompt=""):
        raise EOFError

    monkeypatch.setattr("builtins.input", no_more_input)
    orch = _orchestrator(project, complexity_override="simple", task_description=None)
    orch._agent_runner = ScriptedRunner(orch)

    assert await orch.run(interactive=True, auto_approve=True) is False
    assert not (orch.spec_dir / "complexity_assessment.json").exists()


async def test_a_pause_between_phases_raises_build_paused(project: Path) -> None:
    from foundation.build_signals import BuildPaused
    from foundation.pause_state import write_pause_state

    orch = _orchestrator(project, complexity_override="simple")
    orch._agent_runner = ScriptedRunner(orch)
    write_pause_state(orch.spec_dir, phase="spec")

    with pytest.raises(BuildPaused):
        await orch.run(interactive=False, auto_approve=True)
    assert not (orch.spec_dir / "spec.md").exists()


@pytest.mark.parametrize(
    "outcome", [SystemExit(1), SystemExit(0), KeyboardInterrupt(), "rejected"]
)
async def test_an_unapproved_review_returns_false(
    project: Path, monkeypatch: pytest.MonkeyPatch, outcome
) -> None:
    from review.state import ReviewState

    def checkpoint(spec_dir, auto_approve):
        if isinstance(outcome, BaseException):
            raise outcome
        return ReviewState(approved=False)

    monkeypatch.setattr(orchestrator_module, "run_review_checkpoint", checkpoint)
    orch = _orchestrator(project, complexity_override="simple")
    orch._agent_runner = ScriptedRunner(orch)

    assert await orch.run(interactive=False, auto_approve=False) is False


async def test_index_refresh_failure_and_summary_failure_do_not_stop_the_spec(
    project: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken_index(*args, **kwargs):
        raise RuntimeError("index unavailable")

    async def broken_summary(*args, **kwargs):
        raise RuntimeError("summarizer down")

    monkeypatch.setattr(orchestrator_module, "analyze_project", broken_index)
    monkeypatch.setattr(orchestrator_module, "summarize_phase_output", broken_summary)
    orch = _orchestrator(project, complexity_override="simple")
    runner = ScriptedRunner(orch)
    orch._agent_runner = runner

    assert await orch.run(interactive=False, auto_approve=True) is True

    out = capsys.readouterr().out
    assert "Project index refresh failed: index unavailable" in out
    assert "Phase summarization skipped: summarizer down" in out
    assert runner.calls[0][1] is None
