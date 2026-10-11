"""The complexity assessor is asked only when the heuristic cannot tell.

`complexity_assessor.md` is a 21 KB prompt, and the session reads the
requirements and the project index on top of it. It used to run on every spec,
including the ones the free heuristic in `spec/complexity.py` had already
settled with its strongest signals (audit F10, lot L10). The gate is a
threshold on the heuristic's own confidence, and the decision is written to the
task log either way.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "backend"))

from spec import complexity  # noqa: E402
from spec.complexity import (  # noqa: E402
    AI_ASSESSMENT_CONFIDENCE_THRESHOLD,
    Complexity,
    ComplexityAnalyzer,
    ComplexityAssessment,
    needs_ai_assessment,
)

# Imported at collection, like the spec modules above: importing it inside a
# test runs after other test modules have swapped `core.*` for mocks, and binds
# the orchestrator to those copies for every test that follows.
from spec.pipeline.orchestrator import SpecOrchestrator  # noqa: E402


def _verdict(task: str, requirements: dict | None = None) -> ComplexityAssessment:
    return ComplexityAnalyzer().analyze(task, requirements)


class TestThreshold:
    def test_a_clearly_small_task_needs_no_model(self):
        verdict = _verdict("fix a typo in the button label")
        assert verdict.complexity.value == "simple"
        assert not needs_ai_assessment(verdict)

    def test_a_clearly_large_task_needs_no_model(self):
        verdict = _verdict("integrate stripe and auth0, add a docker deployment")
        assert verdict.complexity.value == "complex"
        assert not needs_ai_assessment(verdict)

    def test_the_fall_through_asks_the_model(self):
        # Nothing decided it: no simple keyword, no strong complex signal.
        verdict = _verdict("add a page that lists the orders")
        assert verdict.complexity.value == "standard"
        assert verdict.confidence < AI_ASSESSMENT_CONFIDENCE_THRESHOLD
        assert needs_ai_assessment(verdict)

    def test_the_threshold_is_the_boundary(self):
        at = ComplexityAssessment(
            Complexity.STANDARD, AI_ASSESSMENT_CONFIDENCE_THRESHOLD
        )
        below = ComplexityAssessment(
            Complexity.STANDARD, AI_ASSESSMENT_CONFIDENCE_THRESHOLD - 0.01
        )
        assert not needs_ai_assessment(at)
        assert needs_ai_assessment(below)

    def test_the_heuristic_says_who_decided(self, tmp_path):
        verdict = _verdict("fix a typo in the button label")
        assert verdict.assessed_by == "heuristic"
        path = complexity.save_assessment(tmp_path, verdict)
        assert (
            json.loads(path.read_text(encoding="utf-8"))["assessed_by"] == "heuristic"
        )


def _orchestrator(tmp_path: Path, task: str):
    orch = object.__new__(SpecOrchestrator)
    orch.spec_dir = tmp_path / "spec"
    orch.spec_dir.mkdir()
    orch.project_dir = tmp_path
    orch.task_description = task
    orch.complexity_override = None
    orch.use_ai_assessment = True
    orch.assessment = None
    ai = ComplexityAssessment(
        Complexity.STANDARD, 0.8, assessed_by="complexity_assessor"
    )
    orch._run_ai_assessment = AsyncMock(return_value=ai)
    return orch


def _run(orch) -> list[str]:
    logger = MagicMock()
    # The method's own globals, not a module name: the full suite can hold two
    # copies of `spec.pipeline.orchestrator`, and a dotted patch target picks one.
    namespace = (
        SpecOrchestrator._phase_complexity_assessment_with_requirements.__globals__
    )
    with patch.dict(namespace, {"get_task_logger": lambda *_a, **_k: logger}):
        asyncio.run(orch._phase_complexity_assessment_with_requirements())
    return [c.args[0] for c in logger.log.call_args_list]


class TestOrchestrator:
    def test_a_confident_heuristic_skips_the_session(self, tmp_path):
        orch = _orchestrator(tmp_path, "fix a typo in the button label")
        lines = _run(orch)
        orch._run_ai_assessment.assert_not_awaited()
        assert orch.assessment.assessed_by == "heuristic"
        assert any("complexity assessor skipped" in line for line in lines)
        saved = json.loads(
            (orch.spec_dir / "complexity_assessment.json").read_text(encoding="utf-8")
        )
        assert saved["complexity"] == "simple"

    def test_an_unsure_heuristic_asks_the_assessor(self, tmp_path):
        orch = _orchestrator(tmp_path, "add a page that lists the orders")
        lines = _run(orch)
        orch._run_ai_assessment.assert_awaited_once()
        # The heuristic verdict is what a failed session falls back to.
        fallback = orch._run_ai_assessment.await_args.kwargs["fallback"]
        assert fallback.complexity.value == "standard"
        assert orch.assessment.assessed_by == "complexity_assessor"
        assert any("asking the complexity assessor" in line for line in lines)

    def test_the_heuristic_reads_the_requirements(self, tmp_path):
        # Three services named in requirements.json are a strong signal the
        # task description alone does not carry.
        orch = _orchestrator(tmp_path, "add a page that lists the orders")
        (orch.spec_dir / "requirements.json").write_text(
            json.dumps(
                {
                    "task_description": "add a page that lists the orders",
                    "services_involved": ["web", "api", "worker"],
                }
            ),
            encoding="utf-8",
        )
        _run(orch)
        orch._run_ai_assessment.assert_not_awaited()
        assert orch.assessment.complexity.value == "complex"

    def test_without_ai_the_heuristic_always_decides(self, tmp_path):
        orch = _orchestrator(tmp_path, "add a page that lists the orders")
        orch.use_ai_assessment = False
        _run(orch)
        orch._run_ai_assessment.assert_not_awaited()
        assert orch.assessment.assessed_by == "heuristic"
