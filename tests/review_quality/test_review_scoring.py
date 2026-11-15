"""Quality score of changed files (review/quality_scorer.py) and the diff
parser and LLM answer reader of the AI code review (review/ai_code_review.py)."""

from __future__ import annotations

from pathlib import Path

from review.ai_code_review import (
    AICodeReviewer,
    ReviewCategory,
    ReviewSeverity,
    parse_unified_diff,
)
from review.quality_scorer import IssueSeverity, QualityScorer


def _titles(scorer: QualityScorer, files: list[str]) -> list[str]:
    return sorted(i.title for i in scorer.score_pr(files).issues)


def test_python_findings(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text(
        'password = "hunter2"\n'
        "eval(x)\nexec(y)\n"
        "subprocess.call(cmd, shell=True)\n"
        "try:\n    run()\nexcept:\n    pass\n",
        encoding="utf-8",
    )
    scorer = QualityScorer(tmp_path)

    score = scorer.score_pr(["a.py"])

    assert sorted(i.title for i in score.issues) == [
        "Bare except",
        "Hardcoded password",
        "Shell injection risk",
        "Use of eval()",
        "Use of exec()",
    ]
    # 3 criticals (45) + 2 highs (16)
    assert score.overall_score == 39.0
    assert score.grade == "F"
    assert score.critical_issues == 3
    assert not score.is_passing


def test_complex_and_deeply_nested_functions(tmp_path: Path) -> None:
    branches = "\n".join(f"    if x == {i}:\n        y = {i}" for i in range(11))
    nested = (
        "def deep(a):\n"
        "    if a:\n        for b in a:\n            while b:\n"
        "                with b:\n                    try:\n"
        "                        if b:\n                            pass\n"
        "                    except ValueError:\n                        pass\n"
    )
    (tmp_path / "c.py").write_text(
        f"def busy(x):\n{branches}\n{nested}", encoding="utf-8"
    )

    titles = _titles(QualityScorer(tmp_path), ["c.py"])

    assert "High cyclomatic complexity" in titles
    assert "Deeply nested code" in titles


def test_syntax_error_and_other_languages(tmp_path: Path) -> None:
    (tmp_path / "bad.py").write_text("def (:\n", encoding="utf-8")
    (tmp_path / "a.ts").write_text("console.log(1)\n", encoding="utf-8")
    (tmp_path / "A.java").write_text("System.out.println(1);\n", encoding="utf-8")
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")
    scorer = QualityScorer(tmp_path)

    score = scorer.score_pr("", ["bad.py", "a.ts", "A.java", "bin.py", "gone.py"])

    syntax = next(i for i in score.issues if i.title == "Syntax Error")
    assert syntax.severity is IssueSeverity.CRITICAL and syntax.line == 1
    assert [i.title for i in score.issues] == ["Syntax Error", "Debug output found"]
    assert QualityScorer(tmp_path).score_pr("diff text").issues == []


def test_grades_follow_the_score(tmp_path: Path) -> None:
    scorer = QualityScorer(tmp_path)
    expected = {
        100: "A+", 95: "A", 91: "A-", 86: "B+", 81: "B", 76: "C",
        71: "C-", 66: "D", 61: "D-", 10: "F",
    }  # fmt: skip

    assert {s: scorer._calculate_grade(s) for s in expected} == expected
    assert scorer.score_pr([]).to_dict()["is_passing"] is True


def test_consecutive_removed_lines_are_all_counted() -> None:
    # Regression: removed lines were keyed by the new file's line, which does
    # not move on a removal; three removed lines kept only the last one.
    files = parse_unified_diff(
        "diff --git a/src/app_test.py b/src/app_test.py\n"
        "--- a/src/app_test.py\n+++ b/src/app_test.py\n"
        "@@ -10,5 +10,2 @@\n"
        " keep()\n"
        "-try:\n"
        "-    validate(x)\n"
        "-except ValueError:\n"
        " done()\n"
        "\\ No newline at end of file\n"
    )

    diff = files[0]
    assert diff.removed_lines == {
        11: "try:",
        12: "    validate(x)",
        13: "except ValueError:",
    }
    assert diff.total_deletions == 3
    assert diff.language == "python"

    result = AICodeReviewer().review_diff(
        "diff --git a/src/app_test.py b/src/app_test.py\n"
        "--- a/src/app_test.py\n+++ b/src/app_test.py\n"
        "@@ -10,4 +10,1 @@\n keep()\n-try:\n-    validate(x)\n-except ValueError:\n"
    )
    rules = {c.rule_id: c for c in result.comments}
    assert {"REG001", "REG002", "REG003"} <= set(rules)
    assert rules["REG002"].line == 11
    assert rules["REG003"].line == 12
    assert rules["REG002"].category is ReviewCategory.REGRESSION


def test_hunk_header_without_numbers_starts_at_line_one() -> None:
    files = parse_unified_diff("diff --git a/x b/x\n@@ weird @@\n-gone\n+new\n")

    assert files[0].removed_lines == {1: "gone"}
    assert files[0].added_lines == {1: "new"}


def test_llm_findings_without_a_message_are_dropped() -> None:
    reviewer = AICodeReviewer()

    comments = reviewer._parse_llm_response(
        "- LINE: 3\n- SEVERITY: banana\n"
        "- LINE: x\n- CATEGORY: nonsense\n- MESSAGE: second\n- SUGGESTION: do\n"
        "- LINE: 9\n- SEVERITY: error\n- CATEGORY: security\n- MESSAGE: third\n"
    )

    assert [(c.line, c.message) for c in comments] == [(0, "second"), (9, "third")]
    assert comments[0].severity is ReviewSeverity.INFO
    assert comments[0].category is ReviewCategory.BEST_PRACTICE
    assert comments[0].suggestion == "do"
    assert comments[1].severity is ReviewSeverity.ERROR
