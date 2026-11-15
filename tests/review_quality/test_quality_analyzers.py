"""Static quality analyzers of the code review (review/quality_*.py).

Each analyzer reads real files written in a temporary project; nothing is
mocked except the grepai search service, which the autofix engine and the
extended scorer query over HTTP and which a test run has no reason to reach.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from review import quality_autofix, quality_extended
from review.quality_autofix import AutoFix, AutoFixEngine
from review.quality_coverage import TestCoverageAnalyzer, analyze_project_coverage
from review.quality_extended import ExtendedQualityScorer, create_extended_scorer
from review.quality_multilang import (
    CSharpAnalyzer,
    GoAnalyzer,
    JavaAnalyzer,
    KotlinAnalyzer,
    RustAnalyzer,
    get_analyzer,
)
from review.quality_performance import (
    PerformanceAnalyzer,
    analyze_project_performance,
)
from review.quality_scorer import IssueSeverity, QualityCategory, QualityIssue
from review.quality_similarity import (
    CodeClone,
    CodeSimilarityDetector,
    detect_clones_in_project,
)


class _Grepai:
    """Stand-in for the grepai HTTP search: records queries, answers a result."""

    queries: list[str] = []
    answer: dict = {"error": "offline"}

    def search_code(self, query: str, top_k: int = 5) -> dict:
        _Grepai.queries.append(query)
        return _Grepai.answer


@pytest.fixture
def grepai(monkeypatch: pytest.MonkeyPatch) -> type[_Grepai]:
    _Grepai.queries = []
    _Grepai.answer = {"error": "offline"}
    monkeypatch.setattr(quality_autofix, "GrepaiConnector", _Grepai)
    monkeypatch.setattr(quality_extended, "GrepaiConnector", _Grepai)
    return _Grepai


def _issue(file: str, line: int | None, title: str = "Issue") -> QualityIssue:
    return QualityIssue(
        category=QualityCategory.BUGS,
        severity=IssueSeverity.HIGH,
        title=title,
        description="desc",
        file=file,
        line=line,
    )


# --------------------------------------------------------------------------
# Code clones
# --------------------------------------------------------------------------

_BLOCK = "\n".join(f"value_{i} = compute({i})" for i in range(8))


def test_clone_between_two_files_is_found_with_its_lines(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text(f"import os\n{_BLOCK}\n", encoding="utf-8")
    (tmp_path / "b.py").write_text(f"# header\n\n{_BLOCK}\n", encoding="utf-8")

    clones = CodeSimilarityDetector(min_lines=6).detect_clones(
        [tmp_path / "a.py", tmp_path / "b.py"]
    )

    assert len(clones) == 1
    clone = clones[0]
    # The block runs to the blank line both files end with.
    assert (clone.line1_start, clone.line1_end) == (2, 10)
    assert (clone.line2_start, clone.line2_end) == (3, 11)
    assert clone.similarity == 1.0
    assert clone.lines_count == 8
    assert clone.code_snippet.endswith("\n...")


def test_block_repeated_inside_one_file_is_a_clone(tmp_path: Path) -> None:
    # Regression: comparing a file with itself only ever matched the whole
    # file at the same place, so no repetition inside a file was reported.
    path = tmp_path / "a.py"
    path.write_text(f"{_BLOCK}\n\nprint(1)\n{_BLOCK}\n", encoding="utf-8")

    clones = CodeSimilarityDetector(min_lines=6).detect_clones([path])

    assert [
        (c.line1_start, c.line1_end, c.line2_start, c.line2_end) for c in clones
    ] == [(1, 8, 11, 18)]
    assert clones[0].file1 == clones[0].file2


def test_overlapping_repetition_is_not_a_self_clone(tmp_path: Path) -> None:
    path = tmp_path / "a.py"
    path.write_text("x = 1\n" * 10, encoding="utf-8")

    clones = CodeSimilarityDetector(min_lines=6).detect_clones([path])

    # Ten equal lines hold one six-line block that does not overlap another
    # only when the second starts six lines later: lines 1-6 and 7-10 cannot
    # both be six long, so nothing is reported.
    assert clones == []


def test_short_blocks_comments_and_missing_files_are_ignored(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("a = 1\nb = 2\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("a = 1\nb = 2\n", encoding="utf-8")
    (tmp_path / "c.py").write_text("# x\n// y\n\n" * 4, encoding="utf-8")
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe\x00bad")
    detector = CodeSimilarityDetector(min_lines=2)

    assert detector._normalize_lines(["  x  ", "# c", "// c", ""]) == ["x", "", "", ""]
    clones = detector.detect_clones(
        [tmp_path / "a.py", tmp_path / "b.py", tmp_path / "missing.py"]
    )
    assert len(clones) == 1
    assert detector.detect_clones([tmp_path / "c.py", tmp_path / "c.py"]) == []
    assert detector._compare_files(tmp_path / "bin.py", tmp_path / "a.py") == []
    assert detector._detect_self_clones(tmp_path / "bin.py") == []
    assert detector._detect_self_clones(tmp_path / "missing.py") == []


def test_dissimilar_blocks_under_the_threshold_are_dropped() -> None:
    detector = CodeSimilarityDetector(min_lines=2, min_similarity=1.1)
    lines = ["a", "b", "c"]
    assert detector._find_clones("x", "y", lines, lines) == []


def _clone(lines: int, same: bool = False) -> CodeClone:
    return CodeClone(
        file1="a.py",
        file2="a.py" if same else "b.py",
        line1_start=1,
        line1_end=lines,
        line2_start=40,
        line2_end=40 + lines,
        similarity=0.9,
        lines_count=lines,
        code_snippet="x = 1",
    )


def test_clone_issues_scale_severity_with_size() -> None:
    detector = CodeSimilarityDetector()
    issues = detector.generate_issues([_clone(30), _clone(15, same=True), _clone(6)])

    assert [i.severity for i in issues] == [
        IssueSeverity.HIGH,
        IssueSeverity.MEDIUM,
        IssueSeverity.LOW,
    ]
    assert issues[0].title.startswith("Code clone detected (30 lines, 90% similar)")
    assert "in b.py at lines 40-70" in issues[0].description
    assert issues[1].title.startswith("Code duplication detected")
    assert "same file at lines 1-15 and 40-55" in issues[1].description
    assert all(i.category is QualityCategory.MAINTAINABILITY for i in issues)


def test_clone_report_groups_by_size() -> None:
    detector = CodeSimilarityDetector()
    assert "No Code Clones Detected" in detector.generate_report([])

    report = detector.generate_report(
        [_clone(30), _clone(20, same=True), _clone(6), _clone(7)]
    )

    assert "**Total clones found**: 4" in report
    assert "Large Clones (1)" in report
    assert "Medium Clones (1)" in report
    assert "*2 small clones detected (< 15 lines)*" in report
    assert "`a.py:1-30` and `b.py:40-70`" in report
    assert "`a.py` lines 1-20 and 40-60" in report


def test_detect_clones_in_project_globs_the_default_languages(tmp_path: Path) -> None:
    js = "\n".join(f"const v{i} = f({i});" for i in range(7))
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.js").write_text(js, encoding="utf-8")
    (tmp_path / "src" / "b.ts").write_text(js, encoding="utf-8")
    (tmp_path / "notes.md").write_text(js, encoding="utf-8")

    clones, issues = detect_clones_in_project(tmp_path)

    assert len(clones) == 1 and len(issues) == 1
    assert {Path(clones[0].file1).name, Path(clones[0].file2).name} == {"a.js", "b.ts"}

    clones, _ = detect_clones_in_project(tmp_path, ["**/*.md"])
    assert clones == []


# --------------------------------------------------------------------------
# Auto-fix
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "line", "title", "fixed", "confidence"),
    [
        ("a.py", "    except:", "Bare except", "    except Exception:", 0.9),
        ("a.js", "console.log(x)", "Debug", "// console.log(x)", 0.8),
        ("A.java", "System.out.println(x);", "Debug", "// System.out.println(x);", 0.8),
        ("a.go", "fmt.Println(x)", "Debug", "// fmt.Println(x)", 0.8),
        ("a.rs", 'println!("x");', "Debug", '// println!("x");', 0.8),
        ("a.kt", "val n = x!!.size", "Nullable", "val n = x?..size", 0.5),
        ("b.rs", "let v = x.unwrap();", "Panic", "let v = x?;", 0.6),
    ],
)
def test_fix_is_generated_per_language(
    tmp_path: Path,
    grepai: type[_Grepai],
    name: str,
    line: str,
    title: str,
    fixed: str,
    confidence: float,
) -> None:
    (tmp_path / name).write_text(f"first\n{line}\n", encoding="utf-8")
    engine = AutoFixEngine(tmp_path)

    fixes = engine.generate_fixes([_issue(name, 2, title)])

    assert [(f.original_line, f.fixed_line, f.confidence) for f in fixes] == [
        (line, fixed, confidence)
    ]
    assert engine.fixes == fixes
    assert grepai.queries == [f"issue:desc file:{name} line:2"]


def test_no_fix_without_a_line_a_file_or_a_known_pattern(
    tmp_path: Path, grepai: type[_Grepai]
) -> None:
    (tmp_path / "a.py").write_text("x = 1\n    except Exception:\n", encoding="utf-8")
    engine = AutoFixEngine(tmp_path)

    assert engine.generate_fixes([_issue("a.py", None)]) == []
    assert engine._generate_fix_for_issue(_issue("missing.py", 1)) is None
    assert engine._generate_fix_for_issue(_issue("a.py", 9)) is None
    assert engine._generate_fix_for_issue(_issue("a.py", 0)) is None
    assert engine._generate_fix_for_issue(_issue("a.py", 1)) is None
    # A bare-except title on a line that already names the exception.
    assert engine._generate_fix_for_issue(_issue("a.py", 2, "Bare except")) is None
    # Bytes that are not UTF-8 are skipped, not raised.
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")
    assert engine._generate_fix_for_issue(_issue("bin.py", 1)) is None


def test_grepai_suggestion_is_reported(
    tmp_path: Path, grepai: type[_Grepai], capsys: pytest.CaptureFixture[str]
) -> None:
    grepai.answer = {"results": ["logger.info"]}
    (tmp_path / "a.js").write_text("console.log(1)\n", encoding="utf-8")

    AutoFixEngine(tmp_path).generate_fixes([_issue("a.js", 1)])

    assert "[Grepai] Suggestion de fix pour a.js:1" in capsys.readouterr().out


def test_apply_fixes_writes_only_confident_matching_lines(
    tmp_path: Path, grepai: type[_Grepai]
) -> None:
    path = tmp_path / "a.js"
    path.write_text("console.log(1)\nkeep()\nconsole.log(2)\n", encoding="utf-8")
    engine = AutoFixEngine(tmp_path)
    fixes = engine.generate_fixes([_issue("a.js", 1), _issue("a.js", 3)])
    stale = AutoFix(_issue("a.js", 2), "other()", "// other()", confidence=1.0)
    outside = AutoFix(_issue("a.js", 99), "x", "y", confidence=1.0)
    unsure = AutoFix(_issue("a.js", 2), "keep()", "// keep()", confidence=0.1)
    gone = AutoFix(_issue("gone.js", 1), "x", "y", confidence=1.0)

    preview = engine.apply_fixes([*fixes, stale, outside, unsure, gone], dry_run=True)
    assert preview == {
        "total_fixes": 5,
        "applied": 2,
        "skipped": 3,
        "errors": 0,
        "files_modified": 0,
        "dry_run": True,
    }
    assert path.read_text(encoding="utf-8").startswith("console.log(1)")

    result = engine.apply_fixes()
    assert result["applied"] == 2 and result["files_modified"] == 1
    assert path.read_text(encoding="utf-8") == (
        "// console.log(1)\nkeep()\n// console.log(2)\n"
    )


def test_apply_fixes_keeps_the_file_line_endings(
    tmp_path: Path, grepai: type[_Grepai]
) -> None:
    # Regression: read_text/write_text translated every line ending, so one
    # fixed line turned a CRLF file into LF (and an LF file into CRLF on
    # Windows).
    path = tmp_path / "a.js"
    path.write_bytes(b"console.log(1)\r\nkeep()\r\n")
    engine = AutoFixEngine(tmp_path)

    engine.apply_fixes(engine.generate_fixes([_issue("a.js", 1)]))

    assert path.read_bytes() == b"// console.log(1)\r\nkeep()\r\n"

    lf = tmp_path / "b.js"
    lf.write_bytes(b"console.log(1)\nkeep()\n")
    engine.apply_fixes(engine.generate_fixes([_issue("b.js", 1)]))
    assert lf.read_bytes() == b"// console.log(1)\nkeep()\n"


def test_apply_fixes_counts_an_unreadable_file_as_errors(
    tmp_path: Path, grepai: type[_Grepai]
) -> None:
    (tmp_path / "bin.js").write_bytes(b"\xff\xfe")
    fix = AutoFix(_issue("bin.js", 1), "x", "y", confidence=1.0)

    result = AutoFixEngine(tmp_path).apply_fixes([fix])

    assert result["errors"] == 1 and result["applied"] == 0


def test_fixable_issues_and_preview(tmp_path: Path, grepai: type[_Grepai]) -> None:
    (tmp_path / "a.js").write_text("console.log(1)\n", encoding="utf-8")
    (tmp_path / "a.kt").write_text("x!!\n", encoding="utf-8")
    engine = AutoFixEngine(tmp_path)
    js, kt = _issue("a.js", 1, "Debug"), _issue("a.kt", 1)

    assert engine.get_fixable_issues([js, kt]) == [js]
    preview = engine.preview_fixes([js])
    assert "**1 fixes** can be applied automatically" in preview
    assert "- **File**: `a.js:1`" in preview
    assert "- **Confidence**: 80%" in preview
    assert engine.preview_fixes([]) == "No automatic fixes available."


# --------------------------------------------------------------------------
# Static test coverage
# --------------------------------------------------------------------------


def _coverage_project(root: Path) -> Path:
    (root / "app.py").write_text(
        "class Cart:\n"
        "    def total(self):\n"
        "        return 0\n"
        "    def _hidden(self):\n"
        "        pass\n"
        "    def __init__(self):\n"
        "        pass\n"
        "def checkout():\n"
        "    pass\n"
        "def refund():\n"
        "    pass\n",
        encoding="utf-8",
    )
    (root / "broken.py").write_text("def (:\n", encoding="utf-8")
    (root / "test_app.py").write_text(
        "from app import Cart, checkout\n"
        "def test_total():\n"
        "    Cart().total()  # refund() mentioned in a comment only\n",
        encoding="utf-8",
    )
    return root


def test_coverage_counts_public_entities_the_tests_reach(tmp_path: Path) -> None:
    # tmp_path lives under a "pytest-of-…" folder: before the fix, the
    # absolute path's "test" excluded every source file of the project.
    stats = TestCoverageAnalyzer(_coverage_project(tmp_path)).analyze_coverage()

    # _hidden is left out; __init__ is listed but not public.
    assert stats["total_entities"] == 5
    assert stats["total_public"] == 4
    # Regression: the import pattern ran over the line end, so `checkout`
    # (last name of the import) read as "checkout\ndef test_total".
    assert stats["tested_entities"] == 3  # Cart, total, checkout
    assert [e["name"] for e in stats["untested_entities"]] == ["refund"]
    assert stats["coverage_percentage"] == pytest.approx(75.0)
    # Regression: this counted the referenced names, not the test files.
    assert stats["test_files_found"] == 1


def test_coverage_skips_sources_under_a_test_folder(tmp_path: Path) -> None:
    (tmp_path / "testing").mkdir()
    (tmp_path / "testing" / "helpers.py").write_text(
        "def helper():\n    pass\n", encoding="utf-8"
    )

    stats = TestCoverageAnalyzer(tmp_path).analyze_coverage()

    assert stats["total_entities"] == 0
    assert stats["coverage_percentage"] == 0


def test_coverage_issues_and_report(tmp_path: Path) -> None:
    stats, issues = analyze_project_coverage(_coverage_project(tmp_path))

    assert [i.title for i in issues] == ["Untested function: refund"]
    assert issues[0].severity is IssueSeverity.MEDIUM
    assert issues[0].suggestion == "Add tests for refund in test_app.py"

    analyzer = TestCoverageAnalyzer(tmp_path)
    report = analyzer.generate_report(stats)
    assert "**Status**: 👍 GOOD" in report  # 75 %
    assert "**`app.py`**:" in report
    assert "- function: `refund` (line 10)" in report

    many = {
        **stats,
        "coverage_percentage": 10,
        "untested_entities": [
            {"file": f"m{i}.py", "name": f"f{i}", "type": "class", "line": 1}
            for i in range(12)
        ],
    }
    report = analyzer.generate_report(many)
    assert "❌ POOR" in report and "*... and 2 more untested entities*" in report
    assert analyzer.generate_issues(many)[0].severity is IssueSeverity.HIGH
    for pct, status in ((85, "✅ EXCELLENT"), (45, "⚠️ FAIR")):
        assert status in analyzer.generate_report(
            {**stats, "coverage_percentage": pct, "untested_entities": []}
        )
    assert "All Public Functions/Classes Have Tests" in analyzer.generate_report(
        {**stats, "untested_entities": []}
    )


def test_coverage_ignores_unreadable_test_files(tmp_path: Path) -> None:
    (tmp_path / "test_bin.py").write_bytes(b"\xff\xfe")
    analyzer = TestCoverageAnalyzer(tmp_path)

    assert analyzer._extract_test_references([tmp_path / "test_bin.py"]) == set()


# --------------------------------------------------------------------------
# Performance
# --------------------------------------------------------------------------


def _titles(issues: list[QualityIssue]) -> list[str]:
    return [i.title for i in issues]


def test_python_performance_smells() -> None:
    code = (
        "from os import *\n"
        "out = []\n"
        "for a in x:\n"
        "    for b in y:\n"
        "        for c in z:\n"
        "            pass\n"
        "for i in items: out.append(i)\n"
        "s = ''\n"
        "while s:\n"
        "    s += 'x'\n"
        "for i in items: k = items.index(i)\n"
        "for i in [1, 2]: ok = i in seen\n"
    )

    issues = PerformanceAnalyzer().analyze_python("a.py", code)

    titles = _titles(issues)
    assert "3-level nested loops detected" in titles
    assert "Wildcard import detected" in titles
    assert "Loop with append() detected" in titles
    assert "String concatenation in loop" in titles
    assert "list.index() in loop" in titles
    assert "'in list' check in loop" in titles
    nested = next(i for i in issues if i.title.startswith("3-level"))
    assert nested.line == 3 and nested.severity is IssueSeverity.HIGH


def test_loops_nested_under_an_if_still_count() -> None:
    # Regression: only a loop that was a direct child of a loop counted, so
    # `for: if: for: for:` was a one-level loop.
    code = (
        "for a in x:\n"
        "    if a:\n"
        "        with open(a) as f:\n"
        "            for b in f:\n"
        "                for c in b:\n"
        "                    pass\n"
        "for d in x:\n"
        "    def inner():\n"
        "        for e in d:\n"
        "            for g in e:\n"
        "                pass\n"
    )

    issues = PerformanceAnalyzer().analyze_python("a.py", code)

    assert [(i.title, i.line) for i in issues if "nested" in i.title] == [
        ("3-level nested loops detected", 1)
    ]


def test_python_syntax_error_yields_nothing() -> None:
    assert PerformanceAnalyzer().analyze_python("a.py", "def (:") == []


def test_javascript_performance_smells() -> None:
    code = (
        "for (i of a) document.getElementById(i)\n"
        "for (a of b) for (c of d) e.map(f)\n"
        "items.forEach(async (x) => await run(x))\n"
        "const fine = 1\n"
    )

    issues = PerformanceAnalyzer().analyze_javascript("a.js", code)

    assert _titles(issues) == [
        "DOM query in loop",
        "Array operations in nested loops",
        "async/await in forEach",
    ]
    assert [i.line for i in issues] == [1, 2, 3]


def test_performance_by_file_and_project(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("from os import *\n", encoding="utf-8")
    (tmp_path / "b.ts").write_text("x.forEach(async y => 1)\n", encoding="utf-8")
    (tmp_path / "c.rb").write_text("puts 1\n", encoding="utf-8")
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")
    analyzer = PerformanceAnalyzer()

    assert analyzer.analyze_file(tmp_path / "missing.py") == []
    assert analyzer.analyze_file(tmp_path / "bin.py") == []
    assert analyzer.analyze_file(tmp_path / "c.rb") == []
    assert sorted(_titles(analyze_project_performance(tmp_path))) == [
        "Wildcard import detected",
        "async/await in forEach",
    ]
    assert analyze_project_performance(tmp_path, ["*.rb"]) == []


# --------------------------------------------------------------------------
# Other languages
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("analyzer", "code", "titles"),
    [
        (
            JavaAnalyzer(),
            "System.out.println(x);\ne.printStackTrace();\n"
            '} catch (Exception e) {\nString password = "hunter2";\n',
            [
                "Debug print statement detected",
                "printStackTrace() should not be used",
                "Catching generic Exception",
                "Hardcoded credentials detected",
            ],
        ),
        (
            KotlinAnalyzer(),
            "println(x)\nval n = x!!\n} catch (e: Exception) {\n",
            [
                "Debug print statement detected",
                "Non-null assertion operator (!!) detected",
                "Catching generic Exception",
            ],
        ),
        (
            CSharpAnalyzer(),
            'Console.WriteLine(x);\ncatch (Exception ex)\nvar connectionString = "Server=db";\n',
            [
                "Debug print statement detected",
                "Catching generic Exception",
                "Hardcoded connection string",
            ],
        ),
        (
            GoAnalyzer(),
            'fmt.Println(x)\npanic("no")\n_ = doThing(err)\n',
            [
                "Debug print statement detected",
                "panic() detected",
                "Error silently ignored",
            ],
        ),
        (
            RustAnalyzer(),
            'println!("x");\nlet a = b.unwrap();\nlet c = d.expect("e");\npanic!("f");\n',
            [
                "Debug print macro detected",
                "unwrap() can cause panic",
                "expect() can cause panic",
                "panic! detected",
            ],
        ),
    ],
)
def test_language_analyzers(analyzer: object, code: str, titles: list[str]) -> None:
    issues = analyzer.analyze(Path("Main.x"), code)  # type: ignore[attr-defined]

    assert _titles(issues) == titles
    assert [i.line for i in issues] == list(range(1, len(titles) + 1))
    assert {i.file for i in issues} == {"Main.x"}


def test_analyzer_is_chosen_by_extension() -> None:
    assert isinstance(get_analyzer(Path("A.JAVA")), JavaAnalyzer)
    assert isinstance(get_analyzer(Path("b.kts")), KotlinAnalyzer)
    assert isinstance(get_analyzer(Path("c.cs")), CSharpAnalyzer)
    assert isinstance(get_analyzer(Path("d.go")), GoAnalyzer)
    assert isinstance(get_analyzer(Path("e.rs")), RustAnalyzer)
    assert get_analyzer(Path("f.rb")) is None


# --------------------------------------------------------------------------
# Extended scorer
# --------------------------------------------------------------------------


def test_extended_scorer_analyzes_every_language(
    tmp_path: Path, grepai: type[_Grepai], capsys: pytest.CaptureFixture[str]
) -> None:
    # Regression: the scorer called a security method that does not exist
    # (AttributeError on every file) and gave the Python and JavaScript
    # analyzers (path, content) for (content, path).
    (tmp_path / "a.py").write_text(
        "try:\n    run()\nexcept:\n    pass\n", encoding="utf-8"
    )
    (tmp_path / "b.js").write_text("console.log(1)\n", encoding="utf-8")
    (tmp_path / "C.java").write_text("System.out.println(1);\n", encoding="utf-8")
    (tmp_path / "d.txt").write_text("plain\n", encoding="utf-8")
    (tmp_path / "bin.py").write_bytes(b"\xff\xfe")
    grepai.answer = {"results": []}

    scorer = create_extended_scorer(tmp_path)
    assert isinstance(scorer, ExtendedQualityScorer)
    score = scorer.score_pr(["a.py", "b.js", "C.java", "d.txt", "bin.py", "missing.py"])

    assert sorted((i.file, i.title) for i in score.issues) == [
        ("C.java", "Debug print statement detected"),
        ("a.py", "Bare except"),
        ("b.js", "Debug output found"),
    ]
    assert len(grepai.queries) == 4
    assert "[Grepai] Analyse enrichie pour a.py" in capsys.readouterr().out
