"""Reading a model's review and triage answers into findings and verdicts.

The PR reviewer and the issue triager ask the model for a fenced ```json
block (runners/github/services/response_parsers.py). What the parser keeps is
what the app shows: a finding without code evidence is dropped, an unknown
verdict falls back to the mildest one, and an unreadable answer leaves the
defaults rather than failing the run.
"""

from __future__ import annotations

import json

from runners.github.models import (
    AICommentVerdict,
    ReviewCategory,
    ReviewSeverity,
    TriageCategory,
)
from runners.github.services.response_parsers import ResponseParser

EVIDENCE = "cursor.execute(f'SELECT * FROM t WHERE id={user_id}')"


def fenced(data) -> str:
    return f"Here is my answer:\n```json\n{json.dumps(data)}\n```\nDone."


def test_a_quick_scan_answer_is_read(capsys):
    scan = {"purpose": "Fix login", "risk_areas": ["auth"], "complexity": "high"}
    assert ResponseParser.parse_scan_result(fenced(scan)) == scan
    assert "[AI] Quick scan result" in capsys.readouterr().out


def test_a_quick_scan_without_json_gives_the_defaults(capsys):
    default = {
        "purpose": "Code changes",
        "risk_areas": [],
        "red_flags": [],
        "complexity": "medium",
    }
    assert ResponseParser.parse_scan_result("no json here") == default
    assert ResponseParser.parse_scan_result("```json\n{not json}\n```") == default
    assert "Failed to parse scan result" in capsys.readouterr().out


def test_findings_with_evidence_are_kept_and_the_rest_dropped(capsys):
    answer = fenced(
        [
            {
                "id": "sql-1",
                "severity": "HIGH",
                "category": "Security",
                "title": "SQL built by hand",
                "description": "Injection",
                "file": "db.py",
                "line": 12,
                "end_line": 14,
                "suggested_fix": "Use parameters",
                "fixable": True,
                "evidence": EVIDENCE,
                "verification_note": "checked",
                "redundant_with": "db2.py:3",
            },
            {"title": "Vague worry", "evidence": "short"},
            {"title": "From a snippet", "code_snippet": EVIDENCE},
        ]
    )
    findings = ResponseParser.parse_review_findings(answer)
    assert [f.id for f in findings] == ["sql-1", "finding-3"]
    first, second = findings
    assert first.severity is ReviewSeverity.HIGH
    assert first.category is ReviewCategory.SECURITY
    assert (first.file, first.line, first.end_line) == ("db.py", 12, 14)
    assert first.fixable is True and first.redundant_with == "db2.py:3"
    assert second.severity is ReviewSeverity.MEDIUM
    assert second.category is ReviewCategory.QUALITY
    assert (second.file, second.line, second.evidence) == ("unknown", 1, EVIDENCE)
    assert "Dropped finding 'Vague worry': insufficient evidence (5 chars < 20)" in (
        capsys.readouterr().out
    )


def test_findings_need_no_evidence_when_the_caller_says_so():
    findings = ResponseParser.parse_review_findings(
        fenced([{"title": "Style", "evidence": "   "}]), require_evidence=False
    )
    assert len(findings) == 1 and findings[0].evidence is None


def test_an_unreadable_findings_answer_gives_none(capsys):
    assert ResponseParser.parse_review_findings("nothing fenced") == []
    bad_severity = fenced([{"severity": "apocalyptic", "evidence": EVIDENCE}])
    assert ResponseParser.parse_review_findings(bad_severity) == []
    assert "Failed to parse findings" in capsys.readouterr().out


def test_structural_issues_are_read_with_their_defaults(capsys):
    issues = ResponseParser.parse_structural_issues(
        fenced(
            [
                {
                    "id": "s-1",
                    "issue_type": "feature_creep",
                    "severity": "High",
                    "title": "Two features",
                    "description": "d",
                    "impact": "i",
                    "suggestion": "split",
                },
                {},
            ]
        )
    )
    assert issues[0].issue_type == "feature_creep"
    assert issues[0].severity is ReviewSeverity.HIGH
    assert (issues[1].id, issues[1].issue_type, issues[1].title) == (
        "struct-2",
        "scope_creep",
        "Structural issue",
    )
    assert ResponseParser.parse_structural_issues("none") == []
    assert ResponseParser.parse_structural_issues(fenced([{"severity": "x"}])) == []
    assert "Failed to parse structural issues" in capsys.readouterr().out


def test_ai_comment_triages_fall_back_to_trivial(capsys):
    triages = ResponseParser.parse_ai_comment_triages(
        fenced(
            [
                {
                    "comment_id": 42,
                    "tool_name": "CodeRabbit",
                    "original_summary": "Rename x",
                    "verdict": "FALSE_POSITIVE",
                    "reasoning": "x is fine",
                    "response_comment": "Thanks, keeping x",
                },
                {"verdict": "made-up"},
            ]
        )
    )
    assert triages[0].verdict is AICommentVerdict.FALSE_POSITIVE
    assert triages[0].original_comment == "Rename x"
    assert triages[1].verdict is AICommentVerdict.TRIVIAL
    assert (triages[1].comment_id, triages[1].tool_name) == (0, "Unknown")
    assert ResponseParser.parse_ai_comment_triages("none") == []
    assert ResponseParser.parse_ai_comment_triages("```json\n[oops]\n```") == []
    assert "Failed to parse AI comment triages" in capsys.readouterr().out


def test_a_triage_answer_fills_the_result():
    result = ResponseParser.parse_triage_result(
        {"number": 4},
        fenced(
            {
                "category": "Duplicate",
                "confidence": "0.85",
                "labels_to_add": ["duplicate"],
                "labels_to_remove": ["needs-triage"],
                "is_duplicate": True,
                "duplicate_of": 2,
                "is_spam": False,
                "is_feature_creep": True,
                "suggested_breakdown": ["a", "b"],
                "priority": "high",
                "comment": "Same as #2",
            }
        ),
        "o/r",
    )
    assert (result.issue_number, result.repo) == (4, "o/r")
    assert result.category is TriageCategory.DUPLICATE
    assert result.confidence == 0.85
    assert result.labels_to_remove == ["needs-triage"]
    assert result.duplicate_of == 2 and result.is_feature_creep is True
    assert result.suggested_breakdown == ["a", "b"]
    assert (result.priority, result.comment) == ("high", "Same as #2")


def test_a_triage_answer_with_an_unknown_category_keeps_feature(capsys):
    unknown = ResponseParser.parse_triage_result(
        {"number": 1}, fenced({"category": "rant", "confidence": 0.3}), "o/r"
    )
    assert unknown.category is TriageCategory.FEATURE
    assert unknown.confidence == 0.3

    unreadable = ResponseParser.parse_triage_result(
        {"number": 1}, fenced({"confidence": "high"}), "o/r"
    )
    assert (unreadable.category, unreadable.confidence) == (TriageCategory.FEATURE, 0.5)
    assert "Failed to parse triage result" in capsys.readouterr().out

    silent = ResponseParser.parse_triage_result({"number": 1}, "no json", "o/r")
    assert silent.confidence == 0.5
