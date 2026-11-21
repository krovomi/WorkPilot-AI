"""An approval counts only when the review step recorded it."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from review.state import (
    REVIEW_STATE_FILE,
    ReviewState,
    keep_reviewed_approval_only,
    read_review_record,
)
from spec.pipeline import orchestrator as orchestrator_module
from spec.pipeline.orchestrator import SpecOrchestrator


def _spec(tmp_path: Path) -> Path:
    spec_dir = tmp_path / "001-export"
    spec_dir.mkdir()
    (spec_dir / "spec.md").write_text("# Export\n", encoding="utf-8")
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    return spec_dir


def _state(spec_dir: Path) -> dict:
    return json.loads((spec_dir / REVIEW_STATE_FILE).read_text(encoding="utf-8"))


def test_the_record_is_the_file_bytes_or_none(tmp_path: Path) -> None:
    spec_dir = _spec(tmp_path)
    assert read_review_record(spec_dir) is None
    ReviewState().approve(spec_dir, approved_by="user")
    assert read_review_record(spec_dir) == (spec_dir / REVIEW_STATE_FILE).read_bytes()


def test_an_unchanged_approval_is_kept(tmp_path: Path) -> None:
    spec_dir = _spec(tmp_path)
    ReviewState().approve(spec_dir, approved_by="user")
    before = read_review_record(spec_dir)

    assert keep_reviewed_approval_only(spec_dir, before) is False
    assert ReviewState.load(spec_dir).is_approval_valid(spec_dir)


def test_no_file_before_and_after_changes_nothing(tmp_path: Path) -> None:
    spec_dir = _spec(tmp_path)
    assert keep_reviewed_approval_only(spec_dir, None) is False
    assert not (spec_dir / REVIEW_STATE_FILE).exists()


def test_a_changed_file_without_approval_is_left_as_it_is(tmp_path: Path) -> None:
    spec_dir = _spec(tmp_path)
    state = ReviewState()
    state.add_feedback("tighten the scope", spec_dir)
    written = (spec_dir / REVIEW_STATE_FILE).read_bytes()

    assert keep_reviewed_approval_only(spec_dir, None) is False
    assert (spec_dir / REVIEW_STATE_FILE).read_bytes() == written


def test_an_approval_that_appeared_is_withdrawn_and_history_kept(
    tmp_path: Path,
) -> None:
    spec_dir = _spec(tmp_path)
    state = ReviewState(feedback=["[2026-11-21 10:00] first pass"])
    state.approve(spec_dir, approved_by="user")

    assert keep_reviewed_approval_only(spec_dir, None) is True
    after = _state(spec_dir)
    assert after["approved"] is False
    assert after["spec_hash"] == ""
    assert after["feedback"] == ["[2026-11-21 10:00] first pass"]
    assert not ReviewState.load(spec_dir).is_approval_valid(spec_dir)


def test_an_approval_rewritten_over_an_older_record_is_withdrawn(
    tmp_path: Path,
) -> None:
    spec_dir = _spec(tmp_path)
    ReviewState().reject(spec_dir)
    before = read_review_record(spec_dir)
    ReviewState.load(spec_dir).approve(spec_dir, approved_by="user")

    assert keep_reviewed_approval_only(spec_dir, before) is True
    assert _state(spec_dir)["approved"] is False


class _ApprovingRunner:
    """A spec session that also leaves an approval in the spec folder."""

    def __init__(self, orchestrator: SpecOrchestrator) -> None:
        self.orchestrator = orchestrator

    async def run_agent(self, prompt_file, *args, **kwargs):
        spec_dir = self.orchestrator.spec_dir
        (spec_dir / "spec.md").write_text(
            "# Specification: export\n\n## Overview\n\nExport.\n\n"
            "## Workflow Type\n\n**Type**: feature\n\n## Task Scope\n\n- Export.\n\n"
            "## Requirements\n\n- FR-001: Export.\n\n"
            "## Success Criteria\n\n1. [ ] Export works.\n",
            encoding="utf-8",
        )
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(
                {
                    "feature": "Export",
                    "workflow_type": "feature",
                    "phases": [
                        {
                            "id": "phase-1",
                            "name": "Export",
                            "subtasks": [
                                {
                                    "id": "1.1",
                                    "description": "Export",
                                    "status": "pending",
                                }
                            ],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (spec_dir / "context.json").write_text(
            json.dumps(
                {
                    "task_description": "Export",
                    "files_to_modify": ["src/export.ts"],
                    "files_to_reference": [],
                    "scoped_services": ["web"],
                }
            ),
            encoding="utf-8",
        )
        ReviewState().approve(spec_dir, approved_by="user")
        return True, f"{prompt_file} done"


async def test_the_spec_pipeline_hands_the_review_no_approval_it_did_not_give(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "shop"
    (project / "src").mkdir(parents=True)
    (project / "package.json").write_text('{"name": "shop"}', encoding="utf-8")
    monkeypatch.setenv("BRAIN_ENABLED", "false")

    async def summarize(phase_name, phase_output, **kwargs):
        return f"summary of {phase_name}"

    seen: list[ReviewState] = []

    def checkpoint(spec_dir, auto_approve):
        state = ReviewState.load(spec_dir)
        seen.append(state)
        return state

    monkeypatch.setattr(orchestrator_module, "summarize_phase_output", summarize)
    monkeypatch.setattr(orchestrator_module, "run_review_checkpoint", checkpoint)
    orch = SpecOrchestrator(
        project_dir=project,
        task_description="Export",
        spec_name="001-export",
        complexity_override="simple",
        use_ai_assessment=False,
    )
    orch._agent_runner = _ApprovingRunner(orch)

    assert await orch.run(interactive=False, auto_approve=False) is False
    assert len(seen) == 1
    assert seen[0].approved is False
    assert not seen[0].is_approval_valid(orch.spec_dir)
