"""Learned patterns, custom rules and quality history (review/quality_ml.py,
review/quality_custom_rules.py, review/quality_integration.py,
review/quality_badge.py), on real files in a temporary project."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest
from review.quality_badge import QualityBadgeFormatter
from review.quality_custom_rules import CustomRule, CustomRuleEngine, load_project_rules
from review.quality_integration import (
    QualityReviewIntegration,
    display_quality_report,
    review_current_pr,
)
from review.quality_ml import LearnedPattern, MLPatternDetector, learn_and_detect
from review.quality_scorer import (
    IssueSeverity,
    QualityCategory,
    QualityIssue,
    QualityScore,
)

# --------------------------------------------------------------------------
# Learned patterns
# --------------------------------------------------------------------------


def _snake_project(root: Path) -> Path:
    body = "\n".join(f"    line_{i} = {i}" for i in range(8))
    for n in range(3):
        (root / f"mod_{n}.py").write_text(
            "import os\nfrom pathlib import Path\nfrom x import *\n"
            f"class Thing{n}:\n    pass\n"
            f"def do_work_{n}():\n{body}\n    return line_0\n",
            encoding="utf-8",
        )
    return root


def test_learning_finds_naming_length_and_indentation(tmp_path: Path) -> None:
    detector = MLPatternDetector(_snake_project(tmp_path))

    stats = detector.learn_from_codebase()

    assert stats["files_analyzed"] == 3
    assert stats["patterns_learned"] == 3
    assert detector.learned_data["imports"] == {
        "absolute_import": 3,
        "from_import": 3,
        "wildcard_import": 3,
    }
    assert detector.learned_data["indentation"] == {"4_spaces": 30}
    ids = {p.pattern_id: p for p in detector.patterns}
    assert (
        ids["naming_convention"].description
        == "Project uses snake_case naming convention"
    )
    assert ids["function_length"].example == "Keep functions around 10 lines"
    assert ids["indentation_style"].example == "4 spaces"
    saved = json.loads(
        (tmp_path / ".workpilot" / "ml-cache" / "learned_patterns.json").read_text(
            encoding="utf-8"
        )
    )
    assert len(saved["patterns"]) == 3


def test_violations_of_learned_patterns(tmp_path: Path) -> None:
    _snake_project(tmp_path)
    MLPatternDetector(tmp_path).learn_from_codebase()
    long_body = "\n".join(f"    v{i} = {i}" for i in range(20))
    code = f"def short():\n  myValue = 1\ndef huge():\n{long_body}\n"

    # A fresh detector reads what the first one saved.
    issues = MLPatternDetector(tmp_path).detect_violations(Path("new.py"), code)

    titles = [i.title for i in issues]
    assert "Naming convention violation (expected snake_case)" in titles
    assert any(
        t.startswith("Function longer than project average (21 vs 10") for t in titles
    )
    assert titles.count("Inconsistent indentation style") == 1
    huge = next(i for i in issues if i.title.startswith("Function longer"))
    assert huge.line == 3


def test_nothing_learned_means_no_violation_and_a_hint(tmp_path: Path) -> None:
    detector = MLPatternDetector(tmp_path)

    assert detector.detect_violations(Path("a.py"), "camelCase = 1") == []
    assert detector.get_report().startswith("No patterns learned yet")

    (tmp_path / ".workpilot" / "ml-cache" / "learned_patterns.json").write_text(
        "{", encoding="utf-8"
    )
    assert detector.detect_violations(Path("a.py"), "camelCase = 1") == []


def test_weak_or_unknown_patterns_are_ignored(tmp_path: Path) -> None:
    detector = MLPatternDetector(tmp_path)
    detector.patterns = [
        LearnedPattern(
            "naming_convention", "naming", "d", "Expected: snake_case", 1, 0.5
        ),
        LearnedPattern("other", "x", "d", "e", 1, 0.9),
    ]

    assert detector.detect_violations(Path("a.py"), "myValue = 1") == []


def test_mixed_styles_learn_no_dominant_convention(tmp_path: Path) -> None:
    (tmp_path / "a.js").write_text(
        "x = 1\ny = 2\nlong_name = 3\nother_name = 4\n\tif (a) {\n  b()\n    c()\n",
        encoding="utf-8",
    )
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")
    detector = MLPatternDetector(tmp_path)

    stats = detector.learn_from_codebase()

    assert stats["files_analyzed"] == 2
    assert detector.learned_data["naming"] == {"lowercase": 2, "snake_case": 2}
    assert detector.learned_data["indentation"] == {
        "tabs": 1,
        "2_spaces": 1,
        "4_spaces": 1,
    }
    assert detector.patterns == []


def test_report_lists_the_patterns(tmp_path: Path) -> None:
    detector = MLPatternDetector(_snake_project(tmp_path))
    detector.learn_from_codebase()

    report = detector.get_report()

    assert "**Total patterns**: 3" in report
    assert "### Project uses snake_case naming convention" in report
    assert "- **Confidence**: 80%" in report


def test_learn_and_detect_checks_existing_files(tmp_path: Path) -> None:
    _snake_project(tmp_path)
    target = tmp_path / "new.py"
    target.write_text("def f():\n  badName = 1\n", encoding="utf-8")

    stats, issues = learn_and_detect(tmp_path, [target, tmp_path / "missing.py"])

    assert stats["files_analyzed"] == 4
    assert {i.file for i in issues} == {str(target)}


# --------------------------------------------------------------------------
# Custom rules
# --------------------------------------------------------------------------


def test_template_rules_load_and_match(tmp_path: Path) -> None:
    config = tmp_path / ".quality-rules.yml"
    CustomRuleEngine().generate_template(config)

    engine = load_project_rules(tmp_path)

    assert [r.id for r in engine.rules] == [
        "no-todo-comments",
        "no-fixme-comments",
        "no-debugger",
        "no-magic-numbers",
    ]
    issues = engine.analyze_file(
        Path("app.js"), "// TODO later\ndebugger;\nconst n = 1000\n// FIXME now\n"
    )
    # Regression: "**/*.js" did not match a file at the project root.
    assert [(i.title, i.line) for i in issues] == [
        ("TODO comments detected", 1),
        ("FIXME comments detected", 4),
        ("Debugger statement detected", 2),
    ]
    assert issues[2].severity is IssueSeverity.HIGH
    assert engine.analyze_file(Path("src/deep/app.py"), "# TODO x\n")[0].line == 1
    assert engine.analyze_file(Path("notes.md"), "TODO\n") == []


def test_rules_round_trip_and_skip_bad_entries(tmp_path: Path) -> None:
    engine = CustomRuleEngine()
    engine.add_rule(
        CustomRule(
            id="no-print",
            name="print call",
            description="use logging",
            category=QualityCategory.MAINTAINABILITY,
            severity=IssueSeverity.LOW,
            pattern=r"\bprint\(",
            file_patterns=["*.py"],
            suggestion="logger.info",
        )
    )
    engine.add_rule(
        CustomRule(
            "bad", "bad", "", QualityCategory.BUGS, IssueSeverity.LOW, "(", ["*"], ""
        )
    )
    out = tmp_path / "rules.yml"
    engine.save_rules(out)

    reloaded = CustomRuleEngine(out)

    assert [r.id for r in reloaded.rules] == ["no-print", "bad"]
    assert [i.title for i in reloaded.analyze_file(Path("a.py"), "print(1)\n")] == [
        "print call"
    ]

    (tmp_path / "broken.yml").write_text(
        "rules:\n  - id: x\n  - id: ok\n    name: ok\n    pattern: y\n"
        "    severity: nonsense\n  - id: ok2\n    name: ok2\n    pattern: z\n"
        "    enabled: false\n",
        encoding="utf-8",
    )
    partial = CustomRuleEngine(tmp_path / "broken.yml")
    assert [r.id for r in partial.rules] == ["ok2"]
    assert partial.analyze_file(Path("a.py"), "z") == []


def test_unusable_rule_files_load_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "empty.yml").write_text("", encoding="utf-8")
    (tmp_path / "bad.yml").write_text("rules: [\n", encoding="utf-8")

    assert CustomRuleEngine(tmp_path / "empty.yml").rules == []
    assert CustomRuleEngine(tmp_path / "bad.yml").rules == []
    assert "Failed to load custom rules" in capsys.readouterr().out
    assert CustomRuleEngine(tmp_path / "missing.yml").rules == []


def test_legacy_rules_file_is_moved_into_the_quality_folder(tmp_path: Path) -> None:
    legacy = tmp_path / ".workpilot" / "quality-rules.yaml"
    legacy.parent.mkdir()
    CustomRuleEngine().generate_template(legacy)

    engine = load_project_rules(tmp_path)

    assert not legacy.exists()
    assert (tmp_path / ".workpilot" / "quality" / "rules.yaml").exists()
    assert len(engine.rules) == 4
    assert load_project_rules(tmp_path / "nowhere").rules == []


# --------------------------------------------------------------------------
# Badges and history
# --------------------------------------------------------------------------


def _score(
    value: float, grade: str, issues: list[QualityIssue] | None = None
) -> QualityScore:
    issues = issues or []
    return QualityScore(
        overall_score=value,
        grade=grade,
        total_issues=len(issues),
        critical_issues=sum(i.severity is IssueSeverity.CRITICAL for i in issues),
        issues=issues,
    )


def _issue(severity: IssueSeverity, n: int = 0) -> QualityIssue:
    return QualityIssue(
        category=QualityCategory.BUGS,
        severity=severity,
        title=f"{severity.value} {n}",
        description="d",
        file="a.py",
        line=n or None,
        suggestion="fix it" if n % 2 else None,
    )


def test_badge_url_is_one_path_segment() -> None:
    # Regression: "95/100" split the badge path and "A+" read as "A ".
    url = QualityBadgeFormatter().generate_shields_badge_url(_score(97.4, "A+"))

    path = urlparse(url).path
    assert path.count("/") == 2
    assert unquote(path) == "/badge/Quality-A+_97/100-brightgreen"
    assert (
        QualityBadgeFormatter()
        .generate_shields_badge_url(_score(50, "?"))
        .endswith("-lightgrey?style=flat-square")
    )
    assert "Quality-C--_72" in QualityBadgeFormatter().generate_shields_badge_url(
        _score(72, "C-")
    )


def test_markdown_and_terminal_reports_list_issues_by_severity() -> None:
    issues = [_issue(IssueSeverity.HIGH, n) for n in range(1, 8)] + [
        _issue(IssueSeverity.LOW, 9)
    ]
    formatter = QualityBadgeFormatter()

    md = formatter.generate_markdown_summary(_score(40, "F", issues))
    assert "#### ⚠️ HIGH (7 issues)" in md
    assert "*... and 2 more high issues*" in md
    assert "  - File: `a.py`:1" in md
    assert "  - 💡 Suggestion: fix it" in md
    assert "#### ℹ️ LOW (1 issues)" in md
    assert "No issues detected" in formatter.generate_markdown_summary(
        _score(100, "A+")
    )

    many = issues + [_issue(IssueSeverity.MEDIUM, 0) for _ in range(4)]
    terminal = formatter.generate_terminal_output(_score(40, "F", many))
    assert "❌ FAILED" in terminal
    assert "      a.py:1" in terminal and "      a.py:?" in terminal
    assert "... et 2 autres issues" in terminal
    assert "✅ PASSED" in formatter.generate_terminal_output(_score(100, "A+"))


def test_integration_review_keeps_history_and_reports(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text(
        "try:\n    x()\nexcept:\n    pass\n", encoding="utf-8"
    )

    async def run() -> list[dict]:
        integration = QualityReviewIntegration(tmp_path)
        first = await integration.review_pr("", ["a.py"], "first", "github", "../12")
        second = await review_current_pr(tmp_path, ["a.py"])
        return [first, second]

    import asyncio

    first, second = asyncio.run(run())

    assert first["grade"] and first["total_issues"] == 1
    # The PR id comes from the forge and the timestamp holds ":" (refused by
    # Windows): neither may shape the report file name.
    assert Path(first["report_path"]).name == "report_-12.md"
    assert Path(first["report_path"]).parent == tmp_path / ".workpilot" / "quality"
    assert ":" not in Path(second["report_path"]).name
    assert Path(second["report_path"]).exists()

    history = QualityReviewIntegration(tmp_path).get_historical_scores()
    assert [h["pr_id"] for h in history] == ["", "../12"]


def _history(root: Path, scores: list[float]) -> QualityReviewIntegration:
    integration = QualityReviewIntegration(root)
    for n, score in enumerate(scores):
        integration._save_history({"pr_id": str(n), "score": score, "grade": "B"})
    return integration


def test_trends_read_the_history_oldest_first(tmp_path: Path) -> None:
    # Regression: the history comes back newest first, so "improving" and
    # "declining" were swapped and recent_scores held the oldest ones.
    rising = _history(tmp_path / "up", [50, 55, 80, 90]).get_quality_trends()
    assert rising["trend"] == "improving"
    assert rising["recent_scores"] == [50, 55, 80, 90]
    assert rising["best_score"] == 90 and rising["worst_score"] == 50
    assert rising["median_score"] == 80
    assert rising["grade_distribution"] == {"B": 4}

    falling = _history(tmp_path / "down", [90, 80, 55, 50]).get_quality_trends()
    assert falling["trend"] == "declining"
    assert (
        _history(tmp_path / "flat", [70, 71, 70, 72]).get_quality_trends()["trend"]
        == "stable"
    )
    few = _history(tmp_path / "few", [70, 80]).get_quality_trends()
    assert few["trend"] == "insufficient_data" and few["average_score"] == 75


def test_history_limit_returns_the_most_recent(tmp_path: Path) -> None:
    integration = _history(tmp_path, [1, 2, 3])
    with (integration.history_dir / "history.jsonl").open("a", encoding="utf-8") as f:
        f.write("\n")

    assert [h["score"] for h in integration.get_historical_scores(limit=2)] == [3, 2]


def test_forge_payloads_and_terminal_display(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    integration = QualityReviewIntegration(tmp_path)
    failing = _score(40, "F", [_issue(IssueSeverity.CRITICAL, 1)])

    github = integration.post_github_comment(7, failing)
    assert github["action"] == "post_comment" and github["pr_number"] == 7
    assert "Code Quality Report" in github["body"]
    assert integration.post_azure_thread(8, failing)["status"] == "active"
    assert integration.post_azure_thread(8, _score(99, "A+"))["status"] == "closed"

    display_quality_report(failing)
    assert "AI CODE REVIEW" in capsys.readouterr().out
