"""Reading a spec-kit project's constitution, when the target project is one.

WorkPilot builds other people's projects, and some of them are spec-kit
projects with their own binding rules written down. The tests that matter are
the ones pinning what happens for the *other* projects: a repository with no
`.specify/` must cost one `is_file()` and produce no prompt section at all.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from project.spec_kit import (  # noqa: E402
    CONSTITUTION_PATH,
    find_constitution,
    format_constitution_for_prompt,
)

CONSTITUTION = """# Project Constitution

## Core Principles

### I. Library-First
Every feature MUST start as a standalone library.

### II. Test-First
Tests MUST be written and MUST fail before implementation.
Contributors SHALL NOT commit generated files by hand.
"""


def _speckit_project(root: Path, text: str = CONSTITUTION) -> Path:
    target = root.joinpath(*CONSTITUTION_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return root


def test_a_project_without_specify_yields_nothing(tmp_path):
    (tmp_path / "src").mkdir()
    assert find_constitution(tmp_path) is None
    assert format_constitution_for_prompt(tmp_path) == ""


def test_the_template_left_empty_is_not_a_set_of_rules(tmp_path):
    """`specify init` writes the file; `/speckit.constitution` fills it."""
    _speckit_project(tmp_path, "   \n\n")
    assert find_constitution(tmp_path) is None
    assert format_constitution_for_prompt(tmp_path) == ""


def test_the_constitution_reaches_the_prompt_whole(tmp_path):
    _speckit_project(tmp_path)
    section = format_constitution_for_prompt(tmp_path)

    assert "PROJECT CONSTITUTION (spec-kit)" in section
    assert "Every feature MUST start as a standalone library." in section
    assert "Tests MUST be written" in section
    # The path is named so the agent can go and read the rest.
    assert ".specify/memory/constitution.md" in section


def test_binding_lines_are_counted_not_quoted(tmp_path):
    """The count is a summary; the prompt gets the document.

    A rule quoted out of its section loses the scope that qualified it — and a
    sentence about what the project *used* to require would be quoted as
    current law.
    """
    found = find_constitution(_speckit_project(tmp_path))
    assert found is not None
    binding = found.binding_lines
    assert len(binding) == 3
    assert all(("MUST" in line or "SHALL" in line) for line in binding)
    assert "## Core Principles" not in binding


def test_a_very_long_constitution_is_truncated_and_says_so(tmp_path):
    _speckit_project(tmp_path, "MUST do the thing.\n" + ("x" * 9000))
    section = format_constitution_for_prompt(tmp_path)

    assert "[truncated" in section
    assert len(section) < 9000


def test_an_unreadable_constitution_is_not_an_error(tmp_path):
    """A directory where the file should be. The build proceeds."""
    target = tmp_path.joinpath(*CONSTITUTION_PATH)
    target.mkdir(parents=True)
    assert find_constitution(tmp_path) is None
    assert format_constitution_for_prompt(tmp_path) == ""
