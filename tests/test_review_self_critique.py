"""The reviewer's self-check before posting (#361): one finding per remark and place."""

from __future__ import annotations

import asyncio

from runners.github.models import (
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewSeverity,
)
from runners.github.services import self_critique

from tests.test_review_feedback_wiring import TestReviewApplies as _Review


def _f(
    fid: str,
    title: str,
    line: int = 10,
    severity: ReviewSeverity = ReviewSeverity.MEDIUM,
    file: str = "a.py",
    category: ReviewCategory = ReviewCategory.QUALITY,
    end_line: int | None = None,
    agents: list[str] | None = None,
    confidence: float = 0.5,
) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=category,
        title=title,
        description="d",
        file=file,
        line=line,
        end_line=end_line,
        source_agents=list(agents or []),
        confidence=confidence,
    )


class TestMergeRedundant:
    def test_one_remark_near_one_place_is_one_finding_at_its_most_severe(self):
        findings = [
            _f("a", "Missing null check.", 10, ReviewSeverity.LOW, agents=["logic"]),
            _f("b", "missing  NULL check", 12, ReviewSeverity.HIGH, agents=["quality"]),
            _f("c", "Missing null check", 13, ReviewSeverity.MEDIUM, agents=["logic"]),
        ]

        kept, merged = self_critique.merge_redundant(findings)

        assert [f.id for f in kept] == ["b"]
        assert kept[0].severity == ReviewSeverity.HIGH
        assert kept[0].source_agents == ["logic", "quality"]
        assert [(m["id"], m["merged_into"], m["severity"]) for m in merged] == [
            ("a", "b", "low"),
            ("c", "b", "medium"),
        ]

    def test_identifiers_numbers_files_and_distance_keep_findings_apart(self):
        findings = [
            _f("os", "Unused import `os`", 1),
            _f("sys", "Unused import `sys`", 2),
            _f("n1", "Retry 3 times", 20),
            _f("n2", "Retry 5 times", 20),
            _f("far", "Unused import `os`", 9),
            _f("other", "Unused import `os`", 1, file="b.py"),
        ]

        kept, merged = self_critique.merge_redundant(findings)

        assert [f.id for f in kept] == ["os", "sys", "n1", "n2", "far", "other"]
        assert merged == []

    def test_a_range_counts_and_the_order_of_the_report_stays(self):
        findings = [
            _f("first", "Leaks the handle", 1),
            _f("range", "Leaks the handle", 30, ReviewSeverity.HIGH, end_line=40),
            _f("inside", "leaks the handle", 42),
            _f("again", "Leaks the handle", 2, ReviewSeverity.CRITICAL),
        ]

        kept, merged = self_critique.merge_redundant(findings)

        assert [f.id for f in kept] == ["range", "again"]
        assert {m["id"]: m["merged_into"] for m in merged} == {
            "inside": "range",
            "first": "again",
        }

    def test_ties_go_to_security_then_confidence(self):
        findings = [
            _f("q", "Unsafe eval", category=ReviewCategory.QUALITY, confidence=0.9),
            _f("s", "Unsafe eval", category=ReviewCategory.SECURITY, confidence=0.2),
            _f("q2", "Tidy this", 50, confidence=0.3),
            _f("q3", "Tidy this", 51, confidence=0.8),
        ]

        kept, _merged = self_critique.merge_redundant(findings)

        assert [f.id for f in kept] == ["s", "q3"]

    def test_a_title_without_words_is_never_merged(self):
        kept, merged = self_critique.merge_redundant([_f("a", "!!"), _f("b", "?")])
        assert [f.id for f in kept] == ["a", "b"]
        assert merged == []


class TestSummaryNote:
    def test_nothing_merged_says_nothing(self):
        assert self_critique.summary_note([]) == ""

    def test_the_list_is_bounded(self, monkeypatch):
        monkeypatch.setattr(self_critique, "MAX_LISTED", 2)
        merged = [
            {
                "id": f"x{i}",
                "title": "T",
                "file": "a.py",
                "line": i,
                "severity": "low",
                "merged_into": "k",
            }
            for i in range(3)
        ]

        note = self_critique.summary_note(merged)

        assert "### Self-check before posting" in note
        assert "3 finding(s) repeated a remark" in note
        assert "- T (a.py:0, low) into k" in note
        assert note.endswith("- and 1 more")


def _followup(findings) -> PRReviewResult:
    return PRReviewResult(
        pr_number=5,
        repo="owner/repo",
        success=True,
        findings=findings,
        summary="## Follow-up",
        verdict=MergeVerdict.NEEDS_REVISION,
        is_followup_review=True,
        unresolved_findings=[f.id for f in findings],
        new_findings_since_last_review=[f.id for f in findings],
    )


class TestFollowup:
    def test_a_merged_report_leaves_the_id_lists(self):
        result = _followup(
            [_f("a", "Leaks the handle", 1), _f("b", "Leaks the handle", 2)]
        )

        assert self_critique.apply_to_followup(result) == 1

        assert [f.id for f in result.findings] == ["a"]
        assert result.unresolved_findings == ["a"]
        assert result.new_findings_since_last_review == ["a"]
        assert "Self-check before posting" in result.summary
        assert result.verdict == MergeVerdict.NEEDS_REVISION

    def test_nothing_to_merge_leaves_it_alone(self):
        distinct = _followup([_f("a", "One", 1), _f("b", "Two", 1)])
        assert self_critique.apply_to_followup(distinct) == 0
        assert distinct.summary == "## Follow-up"
        single = _followup([_f("a", "One")])
        assert self_critique.apply_to_followup(single) == 0
        failed = _followup([_f("a", "One"), _f("b", "One")])
        failed.success = False
        assert self_critique.apply_to_followup(failed) == 0
        assert len(failed.findings) == 2


class TestTheReviewRunsIt:
    """The initial review merges before the verdict and says so in its summary."""

    def test_the_saved_review_has_one_finding_and_the_note(self, tmp_path, monkeypatch):
        config = GitHubRunnerConfig(token="test-token-0000", repo="owner/repo")
        findings = [
            _f("low", "Possible None dereference", 4, ReviewSeverity.LOW),
            _f("high", "Possible None dereference.", 5, ReviewSeverity.HIGH),
        ]
        orch = _Review()._orchestrator(tmp_path, config, findings, monkeypatch)

        result = asyncio.run(orch.review_pr(5))

        assert result.success, result.error
        assert [f.id for f in result.findings] == ["high"]
        assert "Self-check before posting" in result.summary
        assert "into high" in result.summary
