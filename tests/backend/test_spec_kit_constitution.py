"""Reading a spec-kit project's constitution, when the target project is one.

WorkPilot builds other people's projects, and some of them are spec-kit
projects with their own binding rules written down. The tests that matter are
the ones pinning what happens for the *other* projects: a repository with no
`.specify/` must cost one `is_file()` and produce no prompt section at all.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

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


class TestWhoReadsIt:
    """Every phase that judges the project against rules gets the rules.

    The planner and the coder had them from the start. QA and the workflow's
    skill phases did not, which meant the phase that *decides whether the
    result is acceptable* and the phase asked outright "what does this plan do
    that the project forbids" were both answering from conventions they had
    inferred — while the project had written its rules down.
    """

    def test_one_implementation_of_the_section(self):
        """Four callers, one wrapper. Four is four places to forget the guard."""
        from prompts import constitution_section
        from prompts_pkg.prompts import (
            constitution_section as canonical,
        )

        assert constitution_section is canonical

    def test_it_is_empty_for_a_project_that_is_not_one(self, tmp_path):
        from prompts import constitution_section

        assert constitution_section(tmp_path) == ""

    def test_the_qa_reviewer_is_given_the_rules(self, tmp_path):
        from prompts_pkg.prompts import get_qa_reviewer_prompt

        spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
        spec_dir.mkdir(parents=True)
        _speckit_project(tmp_path)

        prompt = get_qa_reviewer_prompt(spec_dir, tmp_path)
        assert "PROJECT CONSTITUTION (spec-kit)" in prompt
        assert "Every feature MUST start as a standalone library." in prompt

    def test_a_plain_project_adds_nothing_to_the_qa_prompt(self, tmp_path):
        from prompts_pkg.prompts import get_qa_reviewer_prompt

        spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
        spec_dir.mkdir(parents=True)

        assert "PROJECT CONSTITUTION" not in get_qa_reviewer_prompt(spec_dir, tmp_path)

    def test_a_skill_phase_prompt_carries_the_rules(self, tmp_path):
        from workflows.runner import PhaseContext, _build_prompt

        _speckit_project(tmp_path)
        spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
        spec_dir.mkdir(parents=True)

        phase = SimpleNamespace(
            id="analyze",
            impl="tooling/spec-analyze",
            pack="tooling",
            skill="spec-analyze",
            description="Read the spec and the plan together.",
        )
        resolved = SimpleNamespace(
            phase=phase, dispatch="fresh-context", degraded_from=None, reason=""
        )
        ctx = PhaseContext(
            project_dir=tmp_path,
            spec_dir=spec_dir,
            model="sonnet",
            repo_root=tmp_path,
        )

        prompt = _build_prompt(resolved, "procedure body", ctx)
        assert "PROJECT CONSTITUTION (spec-kit)" in prompt
        assert "Tests MUST be written" in prompt
        # The procedure still follows the context, not the other way round.
        assert prompt.index("PROJECT CONSTITUTION") < prompt.index("procedure body")
