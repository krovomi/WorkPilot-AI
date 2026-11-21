"""What the CI/CD mode reads from the project: its test run and its commits.

The suite runs with the stack's own command (`suite_runner`), so a .NET, Go or
Java project is tested the way a Python one is. The commit that broke the
build is read from git, the first commit of a history included.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest
from self_healing.incident_responder import cicd_mode
from self_healing.incident_responder.cicd_mode import CICDMode
from self_healing.incident_responder.models import IncidentSeverity
from suite_runner.runs import TestCommand


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
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
    ).stdout.strip()


def _commit(repo: Path, name: str, text: str, message: str) -> str:
    (repo / name).write_text(text, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    return root


# --- the test run -----------------------------------------------------


@pytest.fixture
def pytest_project(tmp_path: Path, monkeypatch) -> Path:
    """A pytest project, run by this interpreter (which has pytest)."""
    project = tmp_path / "project"
    project.mkdir()
    (project / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    command = TestCommand(
        "pytest", "pytest", f'"{sys.executable}" -m pytest -p no:cacheprovider'
    )
    monkeypatch.setattr(cicd_mode, "detect_test_commands", lambda _root: [command])
    return project


def _run(project: Path, **kwargs) -> tuple[bool, str, list[str]]:
    return asyncio.run(CICDMode(project).run_tests(**kwargs))


def test_a_green_suite_reports_no_failure(pytest_project):
    (pytest_project / "test_ok.py").write_text(
        "def test_ok():\n    assert 1 + 1 == 2\n", encoding="utf-8"
    )

    passed, output, failing = _run(pytest_project)

    assert passed and failing == []
    assert "1 passed" in output


def test_a_red_suite_names_its_failing_tests(pytest_project):
    (pytest_project / "test_calc.py").write_text(
        "def test_add():\n    assert 1 + 1 == 3\n\ndef test_ok():\n    pass\n",
        encoding="utf-8",
    )

    passed, output, failing = _run(pytest_project)

    assert not passed
    assert "1 failed" in output
    assert any("test_add" in name for name in failing)


def test_a_suite_over_its_time_is_stopped(pytest_project):
    (pytest_project / "test_slow.py").write_text(
        "import time\n\ndef test_slow():\n    time.sleep(60)\n", encoding="utf-8"
    )

    passed, output, failing = _run(pytest_project, timeout_s=1)

    assert (passed, failing) == (False, ["TIMEOUT"])
    assert "timed out after 1s" in output


def test_a_command_that_cannot_start_is_an_execution_error(tmp_path, monkeypatch):
    command = TestCommand("go", "Go", "workpilot-no-such-runner test ./...")
    monkeypatch.setattr(cicd_mode, "detect_test_commands", lambda _root: [command])

    passed, output, failing = _run(tmp_path)

    assert (passed, failing) == (False, ["EXECUTION_ERROR"])
    assert output.startswith("Failed to run tests:")


def test_a_project_without_a_test_command_says_so(tmp_path):
    (tmp_path / "README.md").write_text("# docs only\n", encoding="utf-8")

    assert _run(tmp_path) == (
        False,
        "No test command detected for this project",
        ["NO_TEST_COMMAND"],
    )


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        ({"go.mod": "module x\n"}, "go"),
        ({"pom.xml": "<project/>"}, "maven"),
        ({"Package.swift": "// swift"}, "swift"),
        ({"app.csproj": '<Project Sdk="Microsoft.NET.Sdk"/>'}, None),
    ],
)
def test_the_command_is_the_stacks_own(tmp_path, monkeypatch, files, expected):
    for name, text in files.items():
        (tmp_path / name).write_text(text, encoding="utf-8")
    ran: list[str] = []

    def record(command, *_args, **_kwargs):
        ran.append(command.id)
        return _Outcome()

    monkeypatch.setattr(cicd_mode, "run_once", record)

    passed, _output, _failing = _run(tmp_path)

    # A .NET project that has no test project has nothing to run.
    assert ran == ([expected] if expected else [])
    assert passed is bool(expected)


class _Outcome:
    exit_code = 0
    timed_out = False
    error = ""
    log = None


# --- the commit -------------------------------------------------------


def test_the_first_commit_of_a_history_has_a_diff(repo):
    sha = _commit(repo, "calc.py", "def add(a, b):\n    return a + b\n", "first")

    diff = CICDMode(repo)._get_commit_diff(sha)

    assert "calc.py" in diff and "+def add(a, b):" in diff


def test_a_later_commit_is_diffed_against_its_parent(repo):
    _commit(repo, "calc.py", "x = 1\n", "first")
    sha = _commit(repo, "calc.py", "x = 2\n", "second")

    diff = CICDMode(repo)._get_commit_diff(sha)

    assert "-x = 1" in diff and "+x = 2" in diff
    assert CICDMode(repo)._get_commit_message("HEAD") == "second"


@pytest.mark.parametrize("ref", ["--output=written-by-git", "not-a-commit", ""])
def test_a_value_that_names_no_commit_is_not_read(repo, ref):
    _commit(repo, "calc.py", "x = 1\n", "first")
    mode = CICDMode(repo)

    assert "no such commit" in mode._get_commit_diff(ref)
    assert mode._get_commit_message(ref) == ""
    assert not (repo / "written-by-git").exists()


def test_a_large_diff_is_cut_for_the_model(repo):
    _commit(repo, "data.txt", "seed\n", "first")
    sha = _commit(repo, "data.txt", "".join(f"line {n}\n" for n in range(12000)), "big")

    diff = CICDMode(repo)._get_commit_diff(sha)

    assert diff.endswith("[diff truncated at 50KB]")


def test_without_git_the_commit_reads_as_unavailable(repo, monkeypatch):
    def no_git(*args, **kwargs):
        raise FileNotFoundError("git")

    monkeypatch.setattr(cicd_mode.subprocess, "run", no_git)
    mode = CICDMode(repo)

    assert mode._get_commit_diff("abc1234").startswith("Failed to get diff for abc1234")
    assert mode._get_commit_message("abc1234") == ""


def test_eleven_failing_tests_are_critical_and_given_names_are_kept(repo):
    sha = _commit(repo, "calc.py", "x = 1\n", "first")
    names = [f"tests/test_x.py::test_{n}" for n in range(11)]

    incident = asyncio.run(
        CICDMode(repo).on_test_failure(
            commit_sha=sha, branch="main", test_output="", failing_tests=names
        )
    )

    assert incident.severity == IncidentSeverity.CRITICAL
    assert incident.source_data["failing_tests"] == names


# --- a capture of the pipeline ----------------------------------------


def test_a_capture_with_no_text_is_not_used(tmp_path):
    text, problem = CICDMode(tmp_path).read_capture(tmp_path / "missing.log")

    assert text == ""
    assert problem.startswith("nothing could be read")


def test_without_the_capture_reader_the_capture_is_not_used(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "docintel.preflight", None)

    text, problem = CICDMode(tmp_path).read_capture(tmp_path / "ci.log")

    assert text == ""
    assert problem.startswith("capture reader unavailable")
