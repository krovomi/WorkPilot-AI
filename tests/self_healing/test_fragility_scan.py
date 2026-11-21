"""What the proactive scan measures in a project, whatever its stack.

Complexity (Python by its AST, every other language by its control keywords),
git churn over the last days, and line coverage from coverage.py or Istanbul
reports combine into one risk score per file.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from self_healing.incident_responder import fragility_analyzer
from self_healing.incident_responder.fragility_analyzer import FragilityAnalyzer


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _scan(project: Path, **kwargs) -> dict[str, object]:
    reports = asyncio.run(
        FragilityAnalyzer(project).analyze(**{"risk_threshold": 0.0, **kwargs})
    )
    return {r.file_path: r for r in reports}


def test_a_project_without_source_has_nothing_to_report(tmp_path):
    _write(tmp_path / "README.md", "# nothing to measure\n")

    assert asyncio.run(FragilityAnalyzer(tmp_path).analyze()) == []


def test_python_complexity_counts_the_decisions_of_its_syntax_tree(tmp_path):
    _write(
        tmp_path / "pkg" / "logic.py",
        "def pick(a, b, c):\n"
        "    assert a\n"
        "    if a and b or c:\n"
        "        for x in a:\n"
        "            while x:\n"
        "                x -= 1\n"
        "    try:\n"
        "        return b\n"
        "    except ValueError:\n"
        "        return c\n"
        "\n"
        "async def later():\n"
        "    return 1\n",
    )
    _write(tmp_path / "pkg" / "broken.py", "def (:\n")

    reports = _scan(tmp_path)

    # 2 functions, assert, if, 2 boolean operators, for, while, except.
    assert reports["pkg/logic.py"].cyclomatic_complexity == 9
    assert reports["pkg/broken.py"].cyclomatic_complexity == 0


def test_other_languages_count_one_decision_per_line(tmp_path):
    _write(
        tmp_path / "src" / "App.cs",
        "class App {\n"
        "  int Run(int a) {\n"
        "    if (a > 0 && a < 9) { return a; }\n"
        "    try { return Work(); } catch (Exception) { throw; }\n"
        "  }\n"
        "}\n",
    )

    assert _scan(tmp_path)["src/App.cs"].cyclomatic_complexity == 2


def test_a_file_gone_since_the_walk_counts_no_complexity(tmp_path):
    analyzer = FragilityAnalyzer(tmp_path)

    assert analyzer._compute_cyclomatic_complexity(tmp_path / "gone.py") == 0.0
    assert analyzer._compute_cyclomatic_complexity(tmp_path / "gone.go") == 0.0


def test_tests_dependencies_and_package_metadata_are_not_scanned(tmp_path):
    _write(tmp_path / "app.py", "x = 1\n")
    _write(tmp_path / "test_app.py", "def test_x(): pass\n")
    _write(tmp_path / "app.spec.ts", "it('x', () => {})\n")
    _write(tmp_path / "node_modules" / "dep" / "index.js", "if (a) {}\n")
    _write(tmp_path / "mypkg.egg-info" / "setup.py", "x = 1\n")
    _write(tmp_path / "notes.txt", "if this were code\n")

    assert list(_scan(tmp_path)) == ["app.py"]


def test_max_files_stops_the_walk_in_a_stable_order(tmp_path):
    for name in ("c.py", "a.py", "b.py"):
        _write(tmp_path / name, "x = 1\n")

    assert sorted(_scan(tmp_path, max_files=2)) == ["a.py", "b.py"]


def test_only_files_at_or_above_the_threshold_are_reported(tmp_path):
    _write(tmp_path / "simple.py", "x = 1\n")
    _write(
        tmp_path / "busy.py",
        "".join(f"def f{i}(a):\n    if a: pass\n" for i in range(30)),
    )

    reports = asyncio.run(FragilityAnalyzer(tmp_path).analyze(risk_threshold=60))

    # Uncovered counts 30 points for both; complexity 60 adds 40 more to busy.
    assert [r.file_path for r in reports] == ["busy.py"]
    assert reports[0].risk_score == 70.0


def test_churn_counts_commits_relative_to_a_project_inside_a_repository(tmp_path):
    repo = tmp_path / "repo"
    project = repo / "services" / "api"
    _write(project / "handler.py", "x = 1\n")
    _write(repo / "handler.py", "x = 1\n")
    _git(repo, "init", "-q")
    for n in range(5):
        if n < 3:
            _write(project / "handler.py", f"x = {n}\n")
        _write(repo / "handler.py", f"y = {n}\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", f"change {n}")

    report = _scan(project)["handler.py"]

    # The repository's own handler.py, changed 5 times, is not this one.
    assert report.git_churn_count == 3
    assert report.risk_score == round(0.3 * 3 / 30 * 100 + 30, 1)


def test_without_git_the_scan_still_measures(tmp_path, monkeypatch):
    _write(tmp_path / "a.py", "x = 1\n")

    def no_git(*args, **kwargs):
        raise FileNotFoundError("git")

    monkeypatch.setattr(fragility_analyzer.subprocess, "run", no_git)

    assert _scan(tmp_path)["a.py"].git_churn_count == 0


def test_coverage_is_read_from_coverage_py(tmp_path):
    _write(tmp_path / "pkg" / "a.py", "x = 1\n")
    _write(tmp_path / "pkg" / "b.py", "x = 1\n")
    _write(
        tmp_path / "coverage.json",
        json.dumps(
            {
                "files": {
                    # coverage.py names files with the separator of its OS.
                    "pkg\\a.py": {"summary": {"percent_covered": 75.0}},
                    "pkg/b.py": {"no summary": True},
                    "pkg/c.py": "not an entry",
                }
            }
        ),
    )

    reports = _scan(tmp_path)

    assert reports["pkg/a.py"].test_coverage_percent == 75.0
    assert reports["pkg/b.py"].test_coverage_percent == 0.0


def test_coverage_is_read_from_istanbul_summary_and_final_reports(tmp_path):
    for name in ("a.ts", "b.ts", "c.ts", "d.ts"):
        _write(tmp_path / "src" / name, "export const x = 1\n")
    _write(
        tmp_path / "coverage" / "coverage-summary.json",
        json.dumps(
            {
                "total": {"lines": {"pct": 50}},
                str(tmp_path / "src" / "a.ts"): {"lines": {"pct": 80}},
                "src/d.ts": {"lines": {"pct": "Unknown"}},
                "src/e.ts": "not an entry",
            }
        ),
    )
    _write(
        tmp_path / "coverage" / "coverage-final.json",
        json.dumps(
            {
                str((tmp_path / "src" / "b.ts").resolve()): {
                    "path": "b.ts",
                    "s": {"0": 3, "1": 0, "2": 1, "3": 0},
                },
                "/elsewhere/c.ts": {"s": {"0": 1}},
                "src/c.ts": {"s": {}},
            }
        ),
    )

    reports = _scan(tmp_path)

    assert reports["src/a.ts"].test_coverage_percent == 80.0
    # Two of its four statements ran: the final format holds hit counts.
    assert reports["src/b.ts"].test_coverage_percent == 50.0
    assert reports["src/c.ts"].test_coverage_percent == 0.0
    assert reports["src/d.ts"].test_coverage_percent == 0.0


@pytest.mark.parametrize("content", ["{not json", "[1, 2]"])
def test_an_unreadable_coverage_report_is_no_coverage(tmp_path, content):
    _write(tmp_path / "a.py", "x = 1\n")
    _write(tmp_path / "coverage.json", content)
    _write(tmp_path / "coverage" / "coverage-summary.json", content)

    assert _scan(tmp_path)["a.py"].test_coverage_percent == 0.0
