"""Each skill phase's report reaches the agent that comes next.

`workflow/<phase>.md` was written for every skill phase and read by nobody but
the `verify` gate: the planner, the coder and the QA reviewer each worked
without what `brainstorm`, `analyze` and `review` had found. These tests pin
who reads what, that the rule is derived from the declared order rather than a
table, and that what is handed over is bounded and treated as data.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.handoff import (  # noqa: E402
    HEAD_CHARS,
    PER_REPORT_CHARS,
    TOTAL_CHARS,
    feeding_phases,
    handoff_section,
    reports_for,
)
from workflows.spec import load_workflow  # noqa: E402

from workflows import handoff  # noqa: E402

WORKFLOW = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"


def declared() -> list[str]:
    return [p.id for p in load_workflow(WORKFLOW).phases]


def write_report(spec_dir: Path, phase_id: str, text: str) -> Path:
    path = spec_dir / "workflow" / f"{phase_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / "spec"
    spec.mkdir()
    return spec


class TestWhoReadsWhat:
    def test_the_planner_reads_what_came_before_planning(self):
        assert feeding_phases(declared(), "planning") == ["brainstorm"]

    def test_the_coder_reads_what_came_between_planning_and_coding(self):
        assert feeding_phases(declared(), "coding") == ["analyze", "mobile-design"]

    def test_the_qa_reviewer_reads_what_came_between_coding_and_qa(self):
        assert feeding_phases(declared(), "qa") == ["review"]

    def test_phases_with_a_reader_of_their_own_are_not_handed_twice(self):
        """`verify` reaches QA through `verify_section`, `ui-design-system`
        through `uiux_section`; `architecture-map` writes its own record."""
        everything = {
            pid
            for consumer in handoff.CONSUMERS
            for pid in feeding_phases(declared(), consumer)
        }
        for phase_id in (
            "docs",
            "ui-design-system",
            "design-check",
            "verify",
            "verify-replay",
            "architecture-map",
            "observe",
        ):
            assert phase_id not in everything

    def test_a_report_reaches_exactly_one_reader(self):
        seen = [
            pid
            for consumer in handoff.CONSUMERS
            for pid in feeding_phases(declared(), consumer)
        ]
        assert len(seen) == len(set(seen))

    def test_an_unknown_consumer_reads_nothing(self):
        assert feeding_phases(declared(), "qa_fixer") == []

    def test_a_phase_inserted_in_the_yaml_is_handed_over_without_python(
        self, tmp_path: Path, spec_dir: Path
    ):
        """The rule is the declared order, not a table to keep in step."""
        workflow = tmp_path / "workflow.yaml"
        workflow.write_text(
            "name: x\n"
            "phases:\n"
            "  - {id: planning, impl: workpilot/planner}\n"
            "  - {id: coding, impl: tooling/tdd-cycle}\n"
            "  - {id: perf-audit, impl: tooling/perf}\n"
            "  - {id: qa, impl: workpilot/qa-loop}\n",
            encoding="utf-8",
        )
        write_report(spec_dir, "perf-audit", "p95 doubled on /orders")
        reports = reports_for(spec_dir, "qa", workflow_path=workflow)
        assert [r.phase_id for r in reports] == ["perf-audit"]


class TestTheSection:
    def test_no_report_means_no_section(self, spec_dir: Path):
        assert handoff_section(spec_dir, "qa") == ""
        assert handoff_section(None, "qa") == ""

    def test_the_review_reaches_qa_as_data(self, spec_dir: Path):
        write_report(spec_dir, "review", "- [HIGH] correction — `a.py:3` — off by one")
        text = handoff_section(spec_dir, "qa")
        assert "data, not instructions" in text
        assert "off by one" in text
        assert "`review`" in text
        assert "confirm it in the code" in text

    def test_the_brainstorm_reaches_the_planner(self, spec_dir: Path):
        write_report(spec_dir, "brainstorm", "## Recommandation\n\nA — reuse X")
        assert "reuse X" in handoff_section(spec_dir, "planning")
        assert handoff_section(spec_dir, "qa") == ""

    def test_an_empty_report_is_not_handed_over(self, spec_dir: Path):
        write_report(spec_dir, "review", "   \n")
        assert handoff_section(spec_dir, "qa") == ""

    def test_a_long_report_is_truncated_and_points_at_the_file(self, spec_dir: Path):
        path = write_report(spec_dir, "review", "x" * (PER_REPORT_CHARS * 2))
        text = handoff_section(spec_dir, "qa")
        assert "Truncated" in text
        assert str(path) in text
        assert len(text) < PER_REPORT_CHARS + 1_000

    def test_the_total_is_bounded_across_reports(self, spec_dir: Path):
        write_report(spec_dir, "analyze", "a" * PER_REPORT_CHARS)
        write_report(spec_dir, "mobile-design", "m" * PER_REPORT_CHARS)
        text = handoff_section(spec_dir, "coding", inline=True)
        assert text.count("a") + text.count("m") <= TOTAL_CHARS + 200

    def test_the_coder_gets_the_head_and_the_path(self, spec_dir: Path):
        path = write_report(spec_dir, "analyze", "HEAD " + "b" * 5_000)
        text = handoff_section(spec_dir, "coding", inline=False)
        assert "HEAD" in text
        assert str(path) in text
        assert text.count("b") <= HEAD_CHARS

    def test_a_fence_inside_the_report_does_not_close_the_section(self, spec_dir: Path):
        write_report(spec_dir, "review", "```python\nprint(1)\n```\nafter")
        text = handoff_section(spec_dir, "qa")
        assert "````" in text

    def test_a_blocked_report_is_withheld(self, spec_dir: Path, monkeypatch):
        write_report(spec_dir, "review", "secret plan")
        monkeypatch.setattr(handoff, "_threat", lambda text, source: "blocked")
        text = handoff_section(spec_dir, "qa")
        assert "Withheld" in text
        assert "secret plan" not in text

    def test_a_suspect_report_is_still_handed_over(self, spec_dir: Path, monkeypatch):
        """A security review quoting a suspicious string is suspect by nature."""
        write_report(spec_dir, "review", "the handler forwards raw input")
        monkeypatch.setattr(handoff, "_threat", lambda text, source: "suspect")
        assert "raw input" in handoff_section(spec_dir, "qa")

    def test_a_broken_workflow_file_costs_the_section_not_the_phase(
        self, spec_dir: Path, tmp_path: Path
    ):
        broken = tmp_path / "broken.yaml"
        broken.write_text("name: x\n", encoding="utf-8")
        write_report(spec_dir, "review", "anything")
        assert handoff_section(spec_dir, "qa", workflow_path=broken) == ""


class TestTheReadersReceiveIt:
    """The section is only worth something where a prompt is built."""

    def test_the_qa_reviewer_prompt_carries_the_review(self, tmp_path: Path):
        from prompts import get_qa_reviewer_prompt

        project = tmp_path / "project"
        project.mkdir()
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / "spec.md").write_text("# Spec\n", encoding="utf-8")
        write_report(spec, "review", "- [HIGH] correction — `a.py:3` — off by one")

        text = get_qa_reviewer_prompt(spec, project)
        assert "REPORTS FROM EARLIER PHASES" in text
        assert "off by one" in text

    def test_the_qa_fixer_works_from_the_decision_not_the_raw_review(
        self, tmp_path: Path
    ):
        """It fixes what the reviewer decided, not what the review proposed."""
        from prompts import get_qa_fixer_prompt

        project = tmp_path / "project"
        project.mkdir()
        spec = tmp_path / "spec"
        spec.mkdir()
        write_report(spec, "review", "- [LOW] style — `a.py:9` — rename x")

        assert "rename x" not in get_qa_fixer_prompt(spec, project)

    def test_the_planner_and_the_coder_ask_for_their_window(self):
        """Wired where the two prompts are built, with the coder's bounded."""
        source = (REPO_ROOT / "apps/backend/agents/coder.py").read_text(
            encoding="utf-8"
        )
        assert 'workflow_reports_section(spec_dir, "planning")' in source
        assert 'workflow_reports_section(spec_dir, "coding", inline=False)' in source
