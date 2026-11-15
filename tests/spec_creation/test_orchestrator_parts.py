"""The parts of SpecOrchestrator around the phases: the agent call and its
rate-limit and context-window sentinels, the complexity verdict (override,
heuristic, assessor), Linear, the task kind, the phase warnings."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from spec.complexity import Complexity
from spec.phases.models import PhaseResult
from spec.pipeline import orchestrator as orchestrator_module
from spec.pipeline.agent_runner import AgentRunner
from spec.pipeline.orchestrator import SpecOrchestrator


class QueuedRunner:
    """Returns the queued answers in order and records each call."""

    def __init__(self, answers, on_call=None):
        self.answers = list(answers)
        self.calls = []
        self.on_call = on_call

    async def run_agent(
        self, prompt_file, additional_context="", interactive=False, **kw
    ):
        self.calls.append((prompt_file, additional_context, kw))
        if self.on_call:
            self.on_call(prompt_file)
        return self.answers.pop(0)


@pytest.fixture
def orch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SpecOrchestrator:
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    project = tmp_path / "app"
    project.mkdir()
    return SpecOrchestrator(
        project_dir=project,
        task_description="Export the monthly invoices as CSV",
        spec_name="001-export",
    )


def test_the_agent_runner_is_built_once_for_this_spec(orch: SpecOrchestrator) -> None:
    runner = orch._get_agent_runner()

    assert isinstance(runner, AgentRunner)
    assert runner.spec_dir == orch.spec_dir
    assert orch._get_agent_runner() is runner


def test_an_existing_spec_directory_is_used_as_given(tmp_path: Path) -> None:
    given = tmp_path / "elsewhere" / "007-from-ui"

    orch = SpecOrchestrator(project_dir=tmp_path / "app", spec_dir=given)

    assert orch.spec_dir == given and given.is_dir()
    assert orch.jev_run.context.spec_dir == given


async def test_a_rate_limit_pauses_then_retries_the_same_phase(
    orch: SpecOrchestrator, monkeypatch: pytest.MonkeyPatch
) -> None:
    paused = []

    async def pause(error, spec_dir, phase):
        paused.append((str(error), phase))
        return True

    monkeypatch.setattr("services.rate_limit_shield.handle_rate_limit_pause", pause)
    orch._phase_summaries = {"discovery": "five services"}
    orch._agent_runner = QueuedRunner(
        [
            (False, "RATE_LIMIT_RETRY_REQUIRED::You've hit your limit::429 resets 5pm"),
            (True, "spec written"),
        ]
    )

    assert await orch._run_agent("spec_writer.md", phase_name="spec_writing") == (
        True,
        "spec written",
    )
    assert paused == [("429 resets 5pm", "spec:spec_writing")]
    calls = orch._agent_runner.calls
    assert len(calls) == 2
    assert "five services" in calls[0][2]["prior_phase_summaries"]


async def test_a_rate_limit_the_shield_cannot_wait_out_fails_the_call(
    orch: SpecOrchestrator, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def cannot_pause(error, spec_dir, phase):
        return False

    monkeypatch.setattr(
        "services.rate_limit_shield.handle_rate_limit_pause", cannot_pause
    )
    answer = "RATE_LIMIT_RETRY_REQUIRED::limit::no reset time"
    orch._agent_runner = QueuedRunner([(False, answer)])

    assert await orch._run_agent("planner.md") == (False, answer)


async def test_a_prompt_too_long_halts_without_retrying(orch: SpecOrchestrator) -> None:
    answer = "PROMPT_TOO_LONG_HALT::too long::Prompt is too long: 250000 tokens"
    orch._agent_runner = QueuedRunner([(False, answer), (True, "never")])

    assert await orch._run_agent("planner.md", phase_name="planning") == (False, answer)
    assert len(orch._agent_runner.calls) == 1


async def test_any_other_failure_is_returned_as_is(orch: SpecOrchestrator) -> None:
    orch._agent_runner = QueuedRunner([(False, "tool crashed")])

    assert await orch._run_agent("planner.md") == (False, "tool crashed")


async def test_an_override_decides_the_complexity(orch: SpecOrchestrator) -> None:
    orch.complexity_override = "complex"

    result = await orch._phase_complexity_assessment_with_requirements()

    assert result.success
    assert orch.assessment.complexity is Complexity.COMPLEX
    assert orch.assessment.assessed_by == "override"
    saved = json.loads(
        (orch.spec_dir / "complexity_assessment.json").read_text("utf-8")
    )
    assert saved["complexity"] == "complex"


async def test_a_confident_heuristic_skips_the_assessor(orch: SpecOrchestrator) -> None:
    orch.task_description = "Fix typo in README"
    orch._agent_runner = QueuedRunner([])

    await orch._phase_complexity_assessment_with_requirements()

    assert orch.assessment.assessed_by == "heuristic"
    assert orch._agent_runner.calls == []


async def test_an_unsure_heuristic_asks_the_assessor(orch: SpecOrchestrator) -> None:
    (orch.spec_dir / "requirements.json").write_text(
        json.dumps(
            {
                "task_description": "Export the monthly invoices as CSV",
                "additional_context": "Finance needs it by Friday",
            }
        ),
        encoding="utf-8",
    )

    def assess(prompt_file):
        (orch.spec_dir / "complexity_assessment.json").write_text(
            json.dumps(
                {
                    "complexity": "complex",
                    "confidence": 0.95,
                    "reasoning": "touches billing and exports",
                    "flags": {"needs_research": True, "needs_self_critique": True},
                }
            ),
            encoding="utf-8",
        )

    orch._agent_runner = QueuedRunner([(True, "assessed")], on_call=assess)

    await orch._phase_complexity_assessment_with_requirements()

    assert orch.assessment.assessed_by == "complexity_assessor"
    assert orch.assessment.complexity is Complexity.COMPLEX
    prompt_file, context, _ = orch._agent_runner.calls[0]
    assert prompt_file == "complexity_assessor.md"
    assert "Finance needs it by Friday" in context
    # The runner states the project directory; the context no longer names
    # .workpilot/ as the project.
    assert "Project Directory" not in context


async def test_a_failed_assessor_keeps_the_heuristic(orch: SpecOrchestrator) -> None:
    orch._agent_runner = QueuedRunner([(False, "assessor failed")])

    await orch._phase_complexity_assessment_with_requirements()

    assert orch.assessment.assessed_by == "heuristic"
    assert orch.assessment.complexity is Complexity.STANDARD


async def test_without_the_assessor_the_heuristic_reads_the_project_index(
    orch: SpecOrchestrator,
) -> None:
    orch.use_ai_assessment = False
    index = orch.project_dir / ".workpilot" / "project_index.json"
    index.write_text(json.dumps({"services": {"api": {}, "web": {}}}), encoding="utf-8")
    (orch.spec_dir / "requirements.json").write_text("{not json", encoding="utf-8")

    assessment = orch._heuristic_assessment()

    assert assessment.assessed_by == "heuristic"
    assert assessment.complexity in set(Complexity)


def test_the_assessment_printout_names_its_flags(
    orch: SpecOrchestrator, capsys: pytest.CaptureFixture[str]
) -> None:
    from spec.complexity import ComplexityAssessment

    orch._print_assessment_info(
        ComplexityAssessment(
            complexity=Complexity.COMPLEX,
            confidence=0.9,
            reasoning="many services",
            needs_research=True,
            needs_self_critique=True,
            assessed_by="complexity_assessor",
        )
    )

    out = capsys.readouterr().out
    assert "AI assessed complexity" in out
    assert "Research phase enabled" in out
    assert "Self-critique phase enabled" in out


@pytest.mark.parametrize("created", [True, False])
async def test_a_linear_task_is_created_when_linear_is_on(
    orch: SpecOrchestrator,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    created: bool,
) -> None:
    from integrations.linear.updater import LinearTaskState

    seen = {}

    async def create(spec_dir, title, description):
        seen.update(title=title, description=description)
        return LinearTaskState(task_id="LIN-42") if created else None

    monkeypatch.setattr("integrations.linear.updater.is_linear_enabled", lambda: True)
    monkeypatch.setattr("integrations.linear.updater.create_linear_task", create)

    await orch._create_linear_task_if_enabled()

    assert seen == {
        "title": "Export the monthly invoices as CSV",
        "description": "Auto-build spec: 001-export",
    }
    out = capsys.readouterr().out
    assert ("Linear task created: LIN-42" in out) is created
    assert ("continuing without" in out) is not created


def test_a_task_kind_that_cannot_be_decided_is_logged_not_raised(
    orch: SpecOrchestrator, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    def broken(*args):
        raise ValueError("no classifier")

    monkeypatch.setattr("tasks.classify_spec", broken)

    orch._record_task_kind()

    assert "task kind not recorded: no classifier" in caplog.text


def test_phase_warnings_reach_the_console_and_the_task_log(
    orch: SpecOrchestrator, capsys: pytest.CaptureFixture[str]
) -> None:
    logged = []

    class Log:
        def log(self, message, entry_type, phase):
            logged.append(message)

    result = PhaseResult(
        "research", True, [], ["Attempt 1: failed"], 1, warnings=["placeholder"]
    )

    orch._report_phase_warnings("research", result, Log())

    assert logged == ["research: placeholder", "research: Attempt 1: failed"]
    assert "research: placeholder" in capsys.readouterr().out


async def test_an_unknown_recommended_phase_is_skipped(
    orch: SpecOrchestrator,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from spec.complexity import ComplexityAssessment

    async def summarize(*args, **kwargs):
        return ""

    async def assess(self):
        self.assessment = ComplexityAssessment(
            complexity=Complexity.SIMPLE,
            confidence=1.0,
            recommended_phases=["discovery", "requirements", "telepathy"],
        )
        return PhaseResult("complexity_assessment", True, [], [], 0)

    monkeypatch.setattr(orchestrator_module, "summarize_phase_output", summarize)
    monkeypatch.setattr(
        SpecOrchestrator, "_phase_complexity_assessment_with_requirements", assess
    )

    assert await orch.run(interactive=False, auto_approve=True) is True
    assert "Unknown phase: telepathy, skipping" in capsys.readouterr().out


def test_planning_failed_survives_an_unwritable_event_stream(
    orch: SpecOrchestrator, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Unwritable:
        @staticmethod
        def from_spec_dir(spec_dir):
            raise OSError("read-only")

    monkeypatch.setattr(orchestrator_module, "TaskEventEmitter", Unwritable)

    orch._emit_planning_failed("planning", ["boom"])


@pytest.mark.parametrize(
    ("index_exists", "stale", "expected"),
    [
        (True, True, "refreshing index"),
        (False, True, "Generating project index"),
        (True, False, "Using cached project index"),
        (False, False, ""),
    ],
)
async def test_the_project_index_is_refreshed_only_when_stale(
    orch: SpecOrchestrator,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    index_exists: bool,
    stale: bool,
    expected: str,
) -> None:
    index = orch.project_dir / ".workpilot" / "project_index.json"
    if index_exists:
        index.write_text("{}", encoding="utf-8")
    analyzed = []
    monkeypatch.setattr(
        orchestrator_module, "should_refresh_project_index", lambda project: stale
    )
    monkeypatch.setattr(
        orchestrator_module, "analyze_project", lambda *a: analyzed.append(a)
    )

    await orch._ensure_fresh_project_index()

    assert bool(analyzed) is stale
    out = capsys.readouterr().out
    assert expected in out
    if not expected:
        assert "index" not in out.lower()


def test_the_rename_keeps_a_folder_whose_target_exists(orch: SpecOrchestrator) -> None:
    pending = orch.specs_dir / "002-pending"
    pending.mkdir()
    (orch.specs_dir / "002-export-invoices").mkdir()
    (pending / "requirements.json").write_text(
        json.dumps({"task_description": "Export invoices"}), encoding="utf-8"
    )
    orch.spec_dir = pending

    assert orch._rename_spec_dir_from_requirements() is True
    assert orch.spec_dir == pending
