"""What a trivial card no longer pays for in the spec pipeline (2026-11-28).

The card "Juste dis-moi si tu vois ce ticket ?" spent 74 % of its 1.36 M tokens
in the spec stage: three "summarize the phase" sessions, a complexity assessor
asked about a 36-character question, a validation fixer that took nine turns to
write a `context.json` and a plan `feature`, and every phase on the launch
model although the card had been switched to Haiku 5.5.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from spec import compaction
from spec.complexity import Complexity, ComplexityAnalyzer, is_short_question
from spec.pipeline.live_engine import card_spec_engine, pending_change

# -- phase summaries ---------------------------------------------------------


async def test_a_short_phase_output_is_its_own_summary(monkeypatch, tmp_path):
    def no_client(**_kwargs):  # pragma: no cover - must not run
        raise AssertionError("no session for a short output")

    monkeypatch.setattr("core.client.create_agent_client", no_client)
    output = '**requirements.json**:\n```\n{"task_description": "x"}\n```'
    summary = await compaction.summarize_phase_output(
        "requirements", output, project_dir=tmp_path, spec_dir=tmp_path
    )
    assert summary == output


def test_the_verbatim_limit_follows_the_target():
    assert compaction.verbatim_max_chars(500) == 3000
    assert compaction.verbatim_max_chars(0) == 0


# -- complexity heuristic -------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Juste dis-moi si tu vois ce ticket ?",
        "Do you see this ticket?",
        "このチケットは見えますか？",
    ],
)
def test_a_short_question_is_simple_without_the_assessor(text):
    assessment = ComplexityAnalyzer().analyze(text)
    assert assessment.complexity is Complexity.SIMPLE
    assert assessment.confidence >= 0.8  # AI_ASSESSMENT_CONFIDENCE_THRESHOLD


def test_a_question_about_infrastructure_is_not_made_simple():
    assessment = ComplexityAnalyzer().analyze("Why does the docker deploy fail?")
    assert assessment.complexity is not Complexity.SIMPLE


@pytest.mark.parametrize(
    "text",
    ["Add a login page", "", "x" * 200 + "?", "Line one?\nline two\nline three?"],
)
def test_what_is_not_a_short_question(text):
    assert not is_short_question(text)


# -- the card's engine, read again before each phase --------------------------


def _metadata(spec_dir: Path, **fields) -> None:
    (spec_dir / "task_metadata.json").write_text(json.dumps(fields), encoding="utf-8")


def test_a_locked_engine_reads_its_spec_row(tmp_path):
    _metadata(
        tmp_path,
        engineLocked=True,
        phaseProviders={"spec": "anthropic"},
        phaseModels={"spec": "claude-haiku-5-5", "planning": "claude-sonnet-5"},
        phaseThinking={"spec": "none", "planning": "high"},
    )
    assert card_spec_engine(tmp_path) == ("anthropic", "claude-haiku-5-5", "none")


def test_a_legacy_task_reads_its_planning_row_first(tmp_path):
    _metadata(
        tmp_path,
        phaseModels={"spec": "claude-haiku-5-5", "planning": "claude-sonnet-5"},
    )
    assert card_spec_engine(tmp_path)[1] == "claude-sonnet-5"


def test_a_change_after_launch_is_pending(monkeypatch, tmp_path):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    _metadata(
        tmp_path,
        engineLocked=True,
        phaseProviders={"spec": "anthropic"},
        phaseModels={"spec": "claude-haiku-5-5"},
        phaseThinking={"spec": "none"},
    )
    change = pending_change(tmp_path, "claude-sonnet-5", "low")
    assert change is not None
    assert change.model == "claude-haiku-5-5"
    assert change.effort == "none"
    assert pending_change(tmp_path, "claude-haiku-5-5", "none") is None


def test_a_provider_change_is_not_applied_mid_spec(monkeypatch, tmp_path):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    _metadata(
        tmp_path,
        engineLocked=True,
        phaseProviders={"spec": "ollama"},
        phaseModels={"spec": "qwen3"},
    )
    assert pending_change(tmp_path, "claude-sonnet-5", "low") is None


def test_no_or_broken_metadata_changes_nothing(tmp_path):
    assert pending_change(tmp_path, "claude-sonnet-5", "low") is None
    (tmp_path / "task_metadata.json").write_text("{not json", encoding="utf-8")
    assert pending_change(tmp_path, "claude-sonnet-5", "low") is None
    _metadata(tmp_path, engineLocked=True, phaseThinking={"spec": "bogus"})
    assert pending_change(tmp_path, "claude-sonnet-5", "low") is None


def test_the_orchestrator_takes_the_change(monkeypatch, tmp_path):
    from spec.pipeline import orchestrator as orch

    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    _metadata(
        tmp_path,
        engineLocked=True,
        phaseModels={"spec": "claude-haiku-5-5"},
        phaseThinking={"spec": "none"},
    )
    self = orch.SpecOrchestrator.__new__(orch.SpecOrchestrator)
    self.spec_dir = tmp_path
    self.model = "claude-sonnet-5"
    self.thinking_level = "low"

    class _Runner:
        model = "claude-sonnet-5"

    self._agent_runner = _Runner()
    logged = []

    class _Logger:
        def log(self, message, *_a, **_k):
            logged.append(message)

    orch.SpecOrchestrator._apply_card_engine(self, _Logger())
    assert self.model == "claude-haiku-5-5"
    assert self._agent_runner.model == "claude-haiku-5-5"
    assert self.thinking_level == "none"
    assert logged and "claude-haiku-5-5" in logged[0]


# -- validation repairs that need no model ------------------------------------


def test_validation_writes_context_and_plan_feature_itself(tmp_path):
    from spec.phases.planning_phases import PlanningPhaseMixin

    (tmp_path / "requirements.json").write_text(
        json.dumps({"task_description": "Juste dis-moi si tu vois ce ticket ?"}),
        encoding="utf-8",
    )
    plan = {
        "workflow_type": "simple",
        "phases": [
            {
                "phase": 1,
                "name": "Check",
                "subtasks": [{"id": "s1", "description": "d", "status": "pending"}],
            }
        ],
    }
    (tmp_path / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )

    phases = PlanningPhaseMixin.__new__(PlanningPhaseMixin)
    phases.spec_dir = tmp_path
    phases.task_description = None
    phases._repair_without_model()

    context = json.loads((tmp_path / "context.json").read_text(encoding="utf-8"))
    assert context["task_description"] == "Juste dis-moi si tu vois ce ticket ?"
    fixed = json.loads(
        (tmp_path / "implementation_plan.json").read_text(encoding="utf-8")
    )
    assert fixed["feature"]
    assert fixed["workflow_type"] == "simple"


def test_the_quick_spec_template_names_the_required_sections():
    from spec.validate_pkg.schemas import SPEC_REQUIRED_SECTIONS

    prompt = (
        Path(__file__).resolve().parents[2] / "apps/backend/prompts/spec_quick.md"
    ).read_text(encoding="utf-8")
    template = prompt.split("## PHASE 2", 1)[1].split("## PHASE 3", 1)[0]
    for section in SPEC_REQUIRED_SECTIONS:
        assert f"## {section}" in template
    assert '"feature"' in prompt.split("## PHASE 3", 1)[1]
