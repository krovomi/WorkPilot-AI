"""Artifacts cost output tokens: the prompts ask for one copy of each fact.

These pin the reductions so a later edit does not bring the five copies of the
QA issues, the completion banners or the planner's narrative files back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

PROMPTS = Path(__file__).resolve().parents[1] / "apps" / "backend" / "prompts"


@pytest.mark.parametrize(
    ("prompt", "banned"),
    [
        ("qa_reviewer.md", "SIGNAL COMPLETION"),
        ("qa_reviewer.md", "Document Everything"),
        ("qa_reviewer.md", "cat > {{SPEC_DIR}}/QA_FIX_REQUEST.md"),
        ("qa_reviewer.md", "cat > {{SPEC_DIR}}/qa_report.md"),
        ("qa_fixer.md", "=== QA FIXES COMPLETE ==="),
        ("planner.md", "=== AUTO-BUILD PROGRESS ==="),
        ("planner.md", '"verification_strategy": {'),
        ("planner.md", '"qa_acceptance": {'),
        ("planner.md", 'speedup_estimate": "'),
        ("spec_writer.md", "500+ chars"),
        ("spec_writer.md", "=== SPEC DOCUMENT CREATED ==="),
        ("spec_critic.md", "=== SPEC CRITIQUE COMPLETE ==="),
        ("followup_planner.md", "=== FOLLOW-UP PLANNING COMPLETE ==="),
    ],
)
def test_verbose_artifact_instructions_stay_gone(prompt: str, banned: str):
    assert banned not in (PROMPTS / prompt).read_text(encoding="utf-8")


def test_reviewer_still_states_a_parsable_verdict():
    from qa.reviewer import _extract_verdict_from_response

    text = (PROMPTS / "qa_reviewer.md").read_text(encoding="utf-8")
    assert "Verdict: APPROVED" in text
    assert _extract_verdict_from_response("…\nVerdict: REJECTED") == "rejected"


def test_shared_system_prompt_carries_the_artifact_rules(tmp_path: Path):
    from core.llm_optimization import ARTIFACT_RULES, build_base_system_prompt

    assert ARTIFACT_RULES in build_base_system_prompt(tmp_path)


def test_qa_report_is_rendered_from_the_signoff(tmp_path: Path):
    from docintel.visual_qa import REPORT_END, REPORT_START
    from qa.report import render_qa_report

    (tmp_path / "qa_report.md").write_text(
        f"old\n\n{REPORT_START}\nvisual\n{REPORT_END}\n", encoding="utf-8"
    )
    signoff = {
        "status": "rejected",
        "qa_session": 2,
        "tests_passed": {"unit": "10/12", "integration": "4/4"},
        "issues_found": [
            {
                "id": "Q1",
                "severity": "critical",
                "title": "Null deref",
                "location": "a.py:3",
                "fix": "guard x",
            }
        ],
    }
    assert render_qa_report(tmp_path, signoff)
    report = (tmp_path / "qa_report.md").read_text(encoding="utf-8")
    assert "**SIGN-OFF**: REJECTED" in report
    assert "Tests: fail" in report  # read by the tests-pass hard gate
    assert "[critical] Null deref — `a.py:3`" in report
    assert "old" not in report


def test_tests_verdict_reads_the_signoff_counts():
    from qa.report import _tests_verdict

    assert _tests_verdict({"unit": "12/12", "e2e": "N/A"}) == "pass"
    assert _tests_verdict({"unit": "PASS"}) == "pass"
    assert _tests_verdict({"unit": "3/4"}) == "fail"
    assert _tests_verdict({"unit": "CANNOT_VERIFY (sandbox)"}) is None
    assert _tests_verdict({}) is None


def test_fixer_prompt_has_its_placeholders_filled(tmp_path: Path):
    from prompts_pkg import get_qa_fixer_prompt

    prompt = get_qa_fixer_prompt(tmp_path, tmp_path)
    assert "{{SPEC_DIR}}" not in prompt
    assert "{{MIN_COVERAGE}}" not in prompt


def test_progress_header_is_written_from_the_plan(tmp_path: Path):
    from implementation_plan.progress_file import write_progress_header

    plan = {
        "feature": "Dark mode",
        "workflow_type": "feature",
        "phases": [
            {"id": "phase-1", "name": "UI", "depends_on": [], "subtasks": [{}, {}]}
        ],
    }
    (tmp_path / "implementation_plan.json").write_text(json.dumps(plan), "utf-8")
    assert write_progress_header(tmp_path)
    text = (tmp_path / "build-progress.txt").read_text(encoding="utf-8")
    assert "Dark mode" in text and "1 phases · 2 subtasks" in text
    # An existing file may hold blockers: never overwritten.
    assert not write_progress_header(tmp_path)
