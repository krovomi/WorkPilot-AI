"""What a coder session is told depends on the stack it works in.

`coder.md` was 35 KB of instructions for every stack at once, and no session
was ever given it (audit F10, lot L10): the coder loop prompts each subtask
with `generate_subtask_prompt`, a core every subtask gets plus modules that
appear only where they apply. These tests hold that assembly — a module that
leaks into every prompt is tokens paid on every subtask of every build, and a
module that disappears is an instruction its stack silently loses.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from prompts_pkg.prompt_generator import generate_subtask_prompt  # noqa: E402

_SUBTASK = {
    "id": "subtask-1-1",
    "description": "Add the endpoint",
    "files_to_modify": ["src/app.py"],
    "verification": {"type": "command", "command": "pytest", "expected": "pass"},
}
_PHASE = {"id": "phase-1", "name": "Backend"}

_DOTNET_MODULE = "## .NET Build Tools"


@pytest.fixture(autouse=True)
def _no_optional_sections(monkeypatch):
    # The stack-aware test plan and the learning loop read the project and
    # the user's history; neither is the assembly under test here.
    monkeypatch.setenv("AUTO_TEST_GENERATION", "false")
    monkeypatch.delenv("TDD_MODE", raising=False)
    monkeypatch.setattr(
        "learning_loop.prompt_injection.get_learning_context",
        lambda *_a, **_k: "",
        raising=False,
    )


def _prompt(project: Path) -> str:
    spec = project / ".workpilot" / "specs" / "001-task"
    spec.mkdir(parents=True)
    return generate_subtask_prompt(spec, project, dict(_SUBTASK), dict(_PHASE))


def test_the_core_reaches_every_stack(tmp_path):
    text = _prompt(tmp_path)
    for part in (
        "## YOUR ENVIRONMENT",
        "**Subtask ID:** `subtask-1-1`",
        "## Files",
        "## Verification",
        "## Instructions",
        "## Quality Checklist",
    ):
        assert part in text, part


def test_the_dotnet_module_only_reaches_a_dotnet_project(tmp_path):
    python = tmp_path / "py"
    python.mkdir()
    (python / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
    assert _DOTNET_MODULE not in _prompt(python)

    dotnet = tmp_path / "net"
    (dotnet / "Api").mkdir(parents=True)
    (dotnet / "Api" / "Api.csproj").write_text(
        '<Project Sdk="Microsoft.NET.Sdk"></Project>', encoding="utf-8"
    )
    assert _DOTNET_MODULE in _prompt(dotnet)


def test_the_prompt_cites_no_section_it_does_not_carry(tmp_path):
    # The environment block used to send the coder to "the PATH CONFUSION
    # PREVENTION section in the coder prompt" — a section of coder.md, which
    # no coder session was given.
    text = _prompt(tmp_path)
    assert "PATH CONFUSION PREVENTION" not in text
    assert "coder prompt" not in text


def test_no_prompt_file_stands_in_for_the_assembly():
    assert not (BACKEND / "prompts" / "coder.md").exists()
