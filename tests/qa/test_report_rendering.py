"""What `qa/report.py` writes for a person: the escalation, the manual plan, the
QA report and fix request rendered from the sign-off, and the visual QA section.

The other `test_qa_report_*.py` files cover the history and the detection of
a project without tests; these pin the remaining shapes and every write that
can fail without the review stopping.
"""

from __future__ import annotations

import json
from pathlib import Path

import docintel.visual_qa as visual_qa
import pytest
from docintel.visual_qa import REPORT_END, REPORT_START, VisualQaRecord
from qa.report import (
    _tests_verdict,
    create_manual_test_plan,
    escalate_to_human,
    is_no_test_project,
    render_fix_request,
    render_qa_report,
    run_visual_qa,
    write_visual_qa_report,
)


@pytest.fixture
def spec(tmp_path: Path) -> Path:
    spec = tmp_path / "spec"
    spec.mkdir()
    return spec


class TestTheEscalation:
    async def test_the_most_common_issues_name_their_file(self, spec):
        issue = {"title": "Null check missing", "file": "src/cart.py", "line": 4}
        bare = {"title": "Flaky timing"}
        history = [
            {"iteration": n, "status": "rejected", "issues": [issue, bare]}
            for n in (1, 2, 3)
        ]
        (spec / "implementation_plan.json").write_text(
            json.dumps({"qa_iteration_history": history}), encoding="utf-8"
        )
        await escalate_to_human(spec, [issue], 3, max_iterations=5, threshold=3)
        text = (spec / "QA_ESCALATION.md").read_text(encoding="utf-8")
        assert "**Iteration**: 3/5" in text
        assert "- **Null check missing** (3 occurrences) in `src/cart.py`\n" in text
        assert "- **Flaky timing** (3 occurrences)\n" in text


class TestTheManualPlan:
    def test_criteria_that_close_the_spec_are_all_read(self, spec):
        (spec / "spec.md").write_text(
            "# Cart\n\n## Acceptance Criteria\n\n- totals add up\n  - the tax shows\n",
            encoding="utf-8",
        )
        text = create_manual_test_plan(spec, "cart").read_text(encoding="utf-8")
        assert "totals add up" in text and "the tax shows" in text


class TestAProjectWithoutTests:
    @pytest.fixture
    def project(self, tmp_path: Path) -> Path:
        project = tmp_path / "project"
        project.mkdir()
        return project

    @pytest.mark.parametrize("framework", ["NUnit", "xunit", "MSTest"])
    def test_a_dotnet_test_project_has_tests(self, spec, project, framework):
        (project / "src").mkdir()
        (project / "src/App.Tests.csproj").write_text(
            f'<PackageReference Include="{framework}" />', encoding="utf-8"
        )
        assert is_no_test_project(spec, project) is False

    def test_a_library_project_alone_has_none(self, spec, project):
        (project / "App.csproj").write_text("<Project/>", encoding="utf-8")
        assert is_no_test_project(spec, project) is True

    def test_an_unreadable_project_file_is_passed_over(self, spec, project):
        (project / "Broken.csproj").mkdir()  # globbed, but not a file
        assert is_no_test_project(spec, project) is True

    def test_a_solution_likely_holds_test_projects(self, spec, project):
        (project / "App.sln").write_text("", encoding="utf-8")
        assert is_no_test_project(spec, project) is False


class TestTheTestsVerdict:
    @pytest.mark.parametrize(
        ("results", "verdict"),
        [
            ({"unit": "", "e2e": "pass"}, "pass"),
            ({"unit": "3/3", "e2e": "FAILED"}, "fail"),
            ({"unit": "2/3 passed"}, "fail"),
            ({"unit": "n/a"}, None),
            ({"unit": ""}, None),
            ({}, None),
            ("pass", None),
        ],
    )
    def test_the_verdict_from_the_results(self, results, verdict):
        assert _tests_verdict(results) == verdict


class TestTheQaReport:
    def test_every_part_of_the_signoff_is_shown(self, spec):
        signoff = {
            "status": "rejected",
            "coverage": {"measured": True, "lines": "n/a"},
            "issues_found": ["a stray line", {"title": "Crash", "file": "a.py"}],
            "next_steps": ["Fix   the crash", "Run the tests"],
        }
        assert render_qa_report(spec, signoff) is True
        text = (spec / "qa_report.md").read_text(encoding="utf-8")
        assert "Coverage:" not in text  # nothing measured in numbers
        assert "## Issues (2)" in text
        assert "2. [issue] Crash — `a.py`" in text  # the stray line is skipped
        assert "## Next steps\n\n- Fix the crash\n- Run the tests\n" in text

    def test_a_symlinked_report_is_not_written_through(self, spec, tmp_path):
        target = tmp_path / "elsewhere.md"
        target.write_text("kept", encoding="utf-8")
        try:
            (spec / "qa_report.md").symlink_to(target)
        except OSError:
            pytest.skip("symlinks are not available here")
        assert render_qa_report(spec, {"status": "approved"}) is False
        assert write_visual_qa_report(spec) is False
        assert target.read_text(encoding="utf-8") == "kept"

    def test_a_report_that_cannot_be_written(self, spec):
        (spec / "qa_report.md").mkdir()
        assert render_qa_report(spec, {"status": "approved"}) is False


class TestTheFixRequest:
    def test_no_issue_to_send(self, spec):
        assert render_fix_request(spec, ["only text", 3], 2) is False
        assert not (spec / "QA_FIX_REQUEST.md").exists()

    def test_a_request_that_cannot_be_written(self, spec):
        (spec / "QA_FIX_REQUEST.md").mkdir()
        assert render_fix_request(spec, [{"title": "Crash"}], 2) is False


class TestVisualQa:
    def test_a_failing_reader_never_stops_the_review(self, spec, monkeypatch):
        def broken(spec_dir, project_dir):
            raise RuntimeError("OCR engine crashed")

        monkeypatch.setattr(visual_qa, "run_visual_qa", broken)
        assert run_visual_qa(spec, spec) is None

    def test_nothing_reviewed_and_the_counts(self, spec, monkeypatch):
        monkeypatch.setattr(
            visual_qa, "run_visual_qa", lambda s, p: VisualQaRecord(skipped="disabled")
        )
        assert run_visual_qa(spec, spec) is None
        record = VisualQaRecord(
            findings=[{"severity": "high"}, {"severity": "low"}, {"severity": "?"}]
        )
        monkeypatch.setattr(visual_qa, "run_visual_qa", lambda s, p: record)
        assert run_visual_qa(spec, spec) == {"high": 1, "medium": 0, "low": 1}

    def test_an_unreadable_report_and_a_failed_write(self, spec, monkeypatch):
        monkeypatch.setattr(visual_qa, "load_visual_qa", lambda s: VisualQaRecord())
        monkeypatch.setattr(visual_qa, "report_markdown", lambda r: "## Visual QA\n")
        (spec / "qa_report.md").mkdir()  # cannot be read, nor written
        assert write_visual_qa_report(spec) is False

    def test_the_section_is_replaced_between_its_markers(self, spec, monkeypatch):
        monkeypatch.setattr(visual_qa, "load_visual_qa", lambda s: VisualQaRecord())
        monkeypatch.setattr(visual_qa, "report_markdown", lambda r: "")
        report = spec / "qa_report.md"
        report.write_text(
            f"# QA Report\n\n{REPORT_START}\nold\n{REPORT_END}\n", encoding="utf-8"
        )
        assert write_visual_qa_report(spec) is True
        assert report.read_text(encoding="utf-8") == "# QA Report\n"
