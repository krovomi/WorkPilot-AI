"""The gate, run for real on a small Python project in a git repository.

A suite that asserts nothing lets the mutants survive and the gate does not
hold; a strict suite kills them. A red suite before mutation, or a budget
that runs out, is ``unknown``. The scratch copy is removed even when the run
raises, and the task's own files are never mutated.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from mutation_gate import commands, engine
from mutation_gate.engine import run_mutation_gate, select_mutants, targets_of_tests
from mutation_gate.mutator import mutants_for
from mutation_gate.native import native_plan, read_cargo_mutants, read_mutation_report
from mutation_gate.sandbox import scratch_copy

SOURCE = "def can_ship(total, lines):\n    return total >= 10 and lines != 0\n"
WEAK = "from shop import can_ship\n\ndef test_runs():\n    assert can_ship(50, 2) is not None\n"
STRICT = (
    "from shop import can_ship\n\n"
    "def test_rules():\n"
    "    assert can_ship(10, 1)\n"
    "    assert not can_ship(9, 1)\n"
    "    assert not can_ship(10, 0)\n"
)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture(autouse=True)
def this_python(monkeypatch):
    # The project's interpreter is this one: pytest is installed here.
    monkeypatch.setattr(commands, "_python", lambda _root: sys.executable)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "pytest.ini").write_text("[pytest]\npythonpath = .\n", encoding="utf-8")
    (root / "shop.py").write_text(
        "def can_ship(total, lines):\n    return True\n", encoding="utf-8"
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    return root, _git(root, "rev-parse", "HEAD")


def _task(root: Path, tests: str, *, commit: bool = True) -> list[str]:
    (root / "shop.py").write_text(SOURCE, encoding="utf-8")
    (root / "tests").mkdir(exist_ok=True)
    (root / "tests" / "test_shop.py").write_text(tests, encoding="utf-8")
    if commit:
        _git(root, "add", "-A")
        _git(root, "commit", "-q", "-m", "task")
    return ["shop.py", "tests/test_shop.py"]


def _worktrees(root: Path) -> int:
    return _git(root, "worktree", "list").count("\n") + 1


def test_tests_that_assert_nothing_do_not_hold(repo):
    root, base = repo
    files = _task(root, WEAK)
    report = run_mutation_gate(root, base, files, threshold=60)
    assert report.status == "fail", report.reason
    assert report.score == 0
    survived = {(r["path"], r["line"], r["description"]) for r in report.survivors}
    assert ("shop.py", 2, ">= becomes >") in survived
    assert ("shop.py", 2, "and becomes or") in survived
    # The task's own file was never mutated, and the copy is gone.
    assert (root / "shop.py").read_text(encoding="utf-8") == SOURCE
    assert _worktrees(root) == 1


def test_a_strict_suite_kills_the_mutants(repo):
    root, base = repo
    # Not committed yet: the fixer's work in progress counts.
    files = _task(root, STRICT, commit=False)
    report = run_mutation_gate(root, base, files, threshold=60)
    assert report.status == "pass", report.results
    assert report.score == 100 and not report.survivors, report.results


def test_a_red_suite_before_mutation_is_unknown(repo):
    root, base = repo
    files = _task(root, "def test_red():\n    assert False\n")
    report = run_mutation_gate(root, base, files, threshold=60)
    assert report.status == "unknown"
    assert "fail before any mutation" in report.reason


def test_a_budget_that_runs_out_is_unknown(repo, monkeypatch):
    root, base = repo
    files = _task(root, STRICT)
    report = run_mutation_gate(root, base, files, threshold=60, total_timeout=0.01)
    assert report.status == "unknown"
    assert "time budget" in report.reason


def test_no_test_command_is_unknown(repo):
    root, base = repo
    (root / "pytest.ini").unlink()
    _git(root, "commit", "-q", "-am", "no pytest")
    base = _git(root, "rev-parse", "HEAD")
    (root / "calc.dart").write_text("bool big(int n) => n > 100;\n", encoding="utf-8")
    report = run_mutation_gate(root, base, ["calc.dart"], threshold=60)
    assert report.status == "unknown" and "no test command" in report.reason


def test_a_diff_without_source_lines_holds(repo):
    root, base = repo
    (root / "README.md").write_text("docs\n", encoding="utf-8")
    report = run_mutation_gate(root, base, ["README.md"], threshold=60)
    assert report.status == "pass" and "nothing for a test to protect" in report.reason


def test_a_test_only_task_mutates_the_code_its_tests_target(repo):
    root, base = repo
    (root / "shop.py").write_text(SOURCE, encoding="utf-8")
    _git(root, "commit", "-q", "-am", "code before the task")
    base = _git(root, "rev-parse", "HEAD")
    (root / "tests").mkdir()
    (root / "tests" / "test_shop.py").write_text(WEAK, encoding="utf-8")
    report = run_mutation_gate(root, base, ["tests/test_shop.py"], threshold=60)
    assert report.status == "fail"
    assert {r["path"] for r in report.survivors} == {"shop.py"}
    assert targets_of_tests(
        ["tests/test_shop.py"], ["shop.py", "tests/test_shop.py"]
    ) == ["shop.py"]


def test_the_scratch_copy_is_removed_after_an_exception(repo):
    root, _ = repo
    (root / "node_modules").mkdir()
    (root / "node_modules" / "keep.js").write_text("x", encoding="utf-8")
    seen: list[Path] = []
    with pytest.raises(RuntimeError), scratch_copy(root) as copy:
        seen.append(copy)
        assert (copy / "node_modules" / "keep.js").is_file()  # linked, not installed
        raise RuntimeError("boom")
    assert not seen[0].exists() and _worktrees(root) == 1
    # The link went, never what it pointed to.
    assert (root / "node_modules" / "keep.js").is_file()


def test_mutants_are_spread_over_files_plan_first():
    code = "\n".join(f"x{i} = a == {i}" for i in range(10)) + "\n"
    candidates = {
        "a.py": mutants_for("a.py", code, set(range(1, 11))),
        "b.py": mutants_for("b.py", code, set(range(1, 11))),
    }
    chosen = select_mutants(candidates, 4, first=("b.py",))
    assert [m.path for m in chosen] == ["b.py", "a.py", "b.py", "a.py"]
    assert len({m.line for m in chosen if m.path == "a.py"}) == 2


def test_native_reports_are_read_and_the_plan_falls_back(tmp_path):
    stryker = {
        "files": {
            "src/a.ts": {
                "mutants": [
                    {
                        "status": "Killed",
                        "mutatorName": "EqualityOperator",
                        "location": {"start": {"line": 3}},
                    },
                    {
                        "status": "Survived",
                        "mutatorName": "ConditionalExpression",
                        "replacement": "true",
                        "location": {"start": {"line": 4}},
                    },
                    {"status": "CompileError", "location": {"start": {"line": 5}}},
                ]
            }
        }
    }
    assert [(r["line"], r["outcome"]) for r in read_mutation_report(stryker)] == [
        (3, "killed"),
        (4, "survived"),
    ]
    cargo = {
        "outcomes": [
            {"scenario": "Baseline", "summary": "Success"},
            {
                "scenario": {
                    "Mutant": {
                        "file": "src/lib.rs",
                        "span": {"start": {"line": 7}},
                        "replacement": "true",
                    }
                },
                "summary": "MissedMutant",
            },
            {
                "scenario": {
                    "Mutant": {"file": "src/lib.rs", "span": {"start": {"line": 9}}}
                },
                "summary": "CaughtMutant",
            },
        ]
    }
    assert [(r["line"], r["outcome"]) for r in read_cargo_mutants(cargo)] == [
        (7, "survived"),
        (9, "killed"),
    ]
    # No Stryker in the project: the generic engine.
    (tmp_path / "package.json").write_text(
        json.dumps({"devDependencies": {"vitest": "1"}})
    )
    assert native_plan(tmp_path, {"src/a.ts": {3}}, None) is None
    (tmp_path / "package.json").write_text(
        json.dumps({"devDependencies": {"@stryker-mutator/core": "9"}})
    )
    plan = native_plan(tmp_path, {"src/a.ts": {3, 8}}, None)
    assert plan.engine == "stryker" and "src/a.ts:3-8" in plan.argv


def test_a_native_tool_without_a_report_falls_back_to_the_generic_engine(
    repo, monkeypatch
):
    root, base = repo
    files = _task(root, WEAK)

    class Plan:
        engine = "fake"
        argv = [sys.executable, "-c", "pass"]
        report = "never-written.json"

        @staticmethod
        def reader(_data):
            return []

    monkeypatch.setattr(engine, "native_plan", lambda *_a: Plan())
    report = run_mutation_gate(root, base, files, threshold=60)
    assert report.engine == "generic" and report.status == "fail"


def test_commands_per_stack(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n")
    argv, cwd = commands.command_for_tests(tmp_path, "pkg/calc/calc.go", [])
    assert argv[-1] == "./pkg/calc/" and cwd == tmp_path
    web = tmp_path / "web"
    web.mkdir()
    (web / "package.json").write_text(json.dumps({"devDependencies": {"vitest": "3"}}))
    argv, cwd = commands.command_for_tests(
        tmp_path, "web/src/a.ts", ["web/src/a.test.ts"]
    )
    assert cwd == web and argv[-1].endswith("src/a.test.ts")
    # A test path a command line would interpret: the whole suite instead.
    argv, _ = commands.command_for_tests(
        tmp_path, "web/src/a.ts", ["web/src/a&b.test.ts"]
    )
    assert not any("a&b" in part for part in argv)
    (tmp_path / "Shop.csproj").write_text("<Project/>")
    argv, _ = commands.command_for_tests(tmp_path, "Order.cs", ["OrderTests.cs"])
    assert "test" in argv and "Shop.csproj" in argv
    assert commands.command_for_tests(tmp_path, "notes.swift", []) is None
