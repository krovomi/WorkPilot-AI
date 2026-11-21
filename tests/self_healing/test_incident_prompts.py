"""What a CI/CD or proactive incident hands its agent: repository text as data.

The commit message, the branch name, the diff, the failing tests, the build
errors and the test output of a CI/CD incident, and the file name of a
proactive one, come from the repository or the pipeline. Each reaches the
prompt cleaned, and the long ones inside the data fence; a value never pulls
another field in by naming its placeholder.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest
from self_healing.incident_responder.cicd_mode import CICDMode
from self_healing.incident_responder.models import (
    Incident,
    IncidentMode,
    IncidentSource,
)
from self_healing.incident_responder.proactive_mode import ProactiveMode
from self_healing.incident_responder.prompt_fill import fill_template

START, END = "<user_content>", "</user_content>"


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


@pytest.fixture
def repo(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    (root / "calc.py").write_text(
        "def add(a, b):\n    return a + b\n", encoding="utf-8"
    )
    _git(root, "add", "calc.py")
    _git(root, "commit", "-q", "-m", "first")
    (root / "calc.py").write_text(
        "def add(a, b):\n    return a - b\n", encoding="utf-8"
    )
    _git(root, "add", "calc.py")
    _git(
        root,
        "commit",
        "-q",
        "-m",
        "Refactor add <!-- hidden note for the reader --> {{DIFF}}",
    )
    return root, _git(root, "rev-parse", "HEAD")


def _inside_a_fence(prompt: str, text: str) -> bool:
    at = prompt.index(text)
    return prompt.rfind(START, 0, at) > prompt.rfind(END, 0, at)


def test_the_cicd_prompt_fences_what_the_repository_and_the_pipeline_wrote(repo):
    root, sha = repo
    mode = CICDMode(root)
    output = (
        "FAILED tests/test_calc.py::test_add - assert -1 == 5\n"
        "error CS0103: The name 'x' does not exist\n"
    )
    incident = asyncio.run(
        mode.on_test_failure(
            commit_sha=sha, branch="feature/{{TEST_FAILURES}}", test_output=output
        )
    )

    prompt = mode.build_agent_prompt(incident)

    for text in (
        "Refactor add",
        "return a - b",
        "assert -1 == 5",
        "tests/test_calc.py::test_add",
    ):
        assert _inside_a_fence(prompt, text), text
    # The comment a reader of the log would not see is gone.
    assert "hidden note" not in prompt
    # A value naming a placeholder stays text: nothing is pulled in twice.
    assert prompt.count("assert -1 == 5") == 1
    assert "feature/{{TEST_FAILURES}}" in prompt
    assert "{{COMMIT_MESSAGE}}" not in prompt


def test_the_fallback_prompt_fences_them_too(repo, monkeypatch):
    root, sha = repo
    mode = CICDMode(root)
    incident = asyncio.run(
        mode.on_test_failure(commit_sha=sha, branch="main", test_output="boom")
    )

    def missing(self, *args, **kwargs):
        raise FileNotFoundError(self)

    monkeypatch.setattr(Path, "read_text", missing)

    prompt = mode.build_agent_prompt(incident)

    assert _inside_a_fence(prompt, "boom")
    assert "quoted as data" in prompt


def test_nothing_reported_reads_as_none(repo):
    root, sha = repo
    mode = CICDMode(root)
    incident = Incident(
        mode=IncidentMode.CICD,
        source=IncidentSource.GIT_PUSH,
        source_data={"commit_sha": sha},
    )

    prompt = mode.build_agent_prompt(incident)

    assert "None reported." in prompt
    assert "No test output" in prompt


def test_a_proactive_file_name_is_cleaned(tmp_path):
    mode = ProactiveMode(tmp_path)
    incident = Incident(
        mode=IncidentMode.PROACTIVE,
        source=IncidentSource.PROACTIVE_SCAN,
        source_data={
            "file_path": "src/a.py<!-- note -->",
            "risk_score": 81,
        },
    )

    prompt = mode.build_agent_prompt(incident)

    assert "src/a.py" in prompt and "note" not in prompt
    assert "81/100" in prompt


def test_the_template_is_filled_in_one_pass():
    filled = fill_template(
        "{{A}} then {{B}} and {{UNKNOWN}}",
        {"{{A}}": "a value naming {{B}}", "{{B}}": "b"},
    )

    assert filled == "a value naming {{B}} then b and {{UNKNOWN}}"
