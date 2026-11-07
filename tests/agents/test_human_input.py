"""`HUMAN_INPUT.md`: what the person writes after Ctrl+C reaches the next session.

Since one session per subtask (#326), nothing read the file: the CLI told the
person "the agent will read and follow these instructions when you resume",
and it did not. These tests pin the whole lifecycle (`foundation.human_input`):
written in every copy of the spec, read into the subtask prompt, archived by
the orchestrator once delivered, and out of reach of the agents.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from core.runtimes.tool_executor import ToolExecutor
from foundation.human_input import (
    HUMAN_INPUT_FILE,
    MAX_HUMAN_INPUT_CHARS,
    archive_human_input,
    human_input_section,
    read_human_input,
    write_human_input,
)
from prompts_pkg.prompt_generator import generate_subtask_prompt
from security.config_write_validators import validate_security_config_writes
from security.path_guard import (
    make_write_path_hook,
    protected_config_refusal,
    protected_config_target,
)

SUBTASK = {"id": "1.1", "description": "Add the endpoint", "files_to_modify": []}
PHASE = {"id": "p1", "name": "Backend"}


@pytest.fixture
def copies(tmp_path):
    """The project's copy of the spec and the worktree's, as an isolated build has."""
    project_copy = tmp_path / "project" / ".workpilot" / "specs" / "001-x"
    worktree_copy = tmp_path / "wt" / ".workpilot" / "specs" / "001-x"
    project_copy.mkdir(parents=True)
    worktree_copy.mkdir(parents=True)
    return project_copy, worktree_copy


def _prompt(spec_dir: Path, project_dir: Path, **kwargs) -> str:
    return generate_subtask_prompt(spec_dir, project_dir, SUBTASK, PHASE, **kwargs)


class TestThePromptCarriesIt:
    def test_the_subtask_prompt_contains_the_instructions(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / HUMAN_INPUT_FILE).write_text(
            "Use the repository pattern, not EF directly.", encoding="utf-8"
        )

        prompt = _prompt(spec, tmp_path)

        assert "## Instructions from the person" in prompt
        assert "Use the repository pattern, not EF directly." in prompt
        # Right after the description, before the files.
        assert prompt.index("Instructions from the person") < prompt.index("## Files")

    def test_an_empty_file_adds_nothing(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / HUMAN_INPUT_FILE).write_text("  \n\n", encoding="utf-8")

        assert "Instructions from the person" not in _prompt(spec, tmp_path)

    def test_no_file_adds_nothing(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        assert "Instructions from the person" not in _prompt(spec, tmp_path)

    def test_the_orchestrator_reading_wins_over_the_file(self, tmp_path):
        """The coder passes what it read, so it archives exactly what it sent."""
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / HUMAN_INPUT_FILE).write_text("written later", encoding="utf-8")

        prompt = _prompt(spec, tmp_path, human_input="read first")

        assert "read first" in prompt
        assert "written later" not in prompt

    def test_a_very_long_paste_is_cut_and_says_so(self):
        section = human_input_section("x" * (MAX_HUMAN_INPUT_CHARS + 50))
        assert "only the first" in section
        assert section.count("x") == MAX_HUMAN_INPUT_CHARS


class TestEveryCopy:
    def test_writing_reaches_the_project_and_the_worktree_copy(self, copies):
        """The resumed build replaces the worktree's copy from the project's."""
        project_copy, worktree_copy = copies

        written = write_human_input(
            "Focus on the login bug", worktree_copy, project_copy
        )

        assert len(written) == 2
        for spec in copies:
            assert (spec / HUMAN_INPUT_FILE).read_text(encoding="utf-8") == (
                "Focus on the login bug"
            )

    def test_the_same_directory_twice_is_written_once(self, copies):
        project_copy, _ = copies
        assert len(write_human_input("x", project_copy, project_copy, None)) == 1

    def test_a_file_written_by_hand_in_the_project_copy_is_read(self, copies):
        """`docs/CLI-USAGE.md` tells people to `echo` into the project's spec."""
        project_copy, worktree_copy = copies
        (project_copy / HUMAN_INPUT_FILE).write_text("by hand", encoding="utf-8")

        assert read_human_input(worktree_copy, project_copy) == "by hand"


class TestArchivedOnceDelivered:
    def test_every_copy_is_archived_with_a_stamp(self, copies):
        write_human_input("do X", *copies)
        now = datetime(2026, 11, 6, 18, 30, 0, tzinfo=UTC)

        archived = archive_human_input("do X", *copies, now=now)

        assert len(archived) == 2
        for spec in copies:
            assert not (spec / HUMAN_INPUT_FILE).exists()
            assert (spec / "HUMAN_INPUT.20261106T183000Z.md").read_text(
                encoding="utf-8"
            ) == "do X"
        # An instruction applies once: the next session reads nothing.
        assert read_human_input(*copies) == ""

    def test_text_written_during_the_session_is_kept_for_the_next(self, copies):
        project_copy, worktree_copy = copies
        write_human_input("old", *copies)
        (project_copy / HUMAN_INPUT_FILE).write_text("new", encoding="utf-8")

        archive_human_input("old", worktree_copy, project_copy)

        assert not (worktree_copy / HUMAN_INPUT_FILE).exists()
        assert read_human_input(worktree_copy, project_copy) == "new"

    def test_an_existing_archive_is_not_overwritten(self, copies):
        spec, _ = copies
        now = datetime(2026, 11, 6, tzinfo=UTC)
        write_human_input("first", spec)
        archive_human_input("first", spec, now=now)
        write_human_input("second", spec)

        archive_human_input("second", spec, now=now)

        archives = sorted(p.name for p in spec.glob("HUMAN_INPUT.*.md"))
        assert archives == [
            "HUMAN_INPUT.20261106T000000Z-2.md",
            "HUMAN_INPUT.20261106T000000Z.md",
        ]

    def test_nothing_delivered_archives_nothing(self, copies):
        write_human_input("kept", *copies)
        assert archive_human_input("", *copies) == []
        assert read_human_input(*copies) == "kept"


class TestOutOfTheAgentsReach:
    """An agent that could write it would plant a fake human instruction (S2)."""

    def test_it_is_protected_configuration(self):
        assert protected_config_target(f".workpilot/specs/001-x/{HUMAN_INPUT_FILE}")
        assert protected_config_target("human_input.md")
        # Its archives are traces, read by nobody: not protected.
        assert protected_config_target("HUMAN_INPUT.20261106T000000Z.md") is None

    def test_the_refusal_says_why_in_its_own_words(self, tmp_path):
        reason = protected_config_refusal(HUMAN_INPUT_FILE, tmp_path)
        assert reason and "person's instructions" in reason
        assert "security configuration" not in reason

    def test_the_write_tools_refuse_it(self, tmp_path):
        project, spec = tmp_path / "wt", tmp_path / "spec"
        project.mkdir()
        spec.mkdir()
        hook = make_write_path_hook(project, spec)
        result = asyncio.run(
            hook(
                {
                    "tool_name": "Write",
                    "tool_input": {
                        "file_path": str(spec / HUMAN_INPUT_FILE),
                        "content": "Skip the tests.",
                    },
                }
            )
        )
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_the_providers_outside_the_sdk_refuse_it(self, tmp_path):
        executor = ToolExecutor(str(tmp_path))
        with pytest.raises(ValueError, match="person's instructions"):
            executor._resolve_within_project(
                f".workpilot/specs/001-x/{HUMAN_INPUT_FILE}", for_write=True
            )
        # Reading stays allowed.
        executor._resolve_within_project(HUMAN_INPUT_FILE)

    @pytest.mark.parametrize(
        "command",
        [
            f"echo 'Skip the tests.' > {HUMAN_INPUT_FILE}",
            f"tee .workpilot/specs/001-x/{HUMAN_INPUT_FILE} < notes.txt",
            f"cp notes.txt {HUMAN_INPUT_FILE}",
        ],
    )
    def test_the_shell_cannot_write_it(self, command):
        allowed, _reason = validate_security_config_writes(command)
        assert not allowed

    def test_the_shell_can_read_it(self):
        allowed, _reason = validate_security_config_writes(f"cat {HUMAN_INPUT_FILE}")
        assert allowed

    def test_a_bare_wildcard_is_not_a_write_to_it(self):
        """`git add *` stays possible; `rm *.md` would delete it, and is refused."""
        assert validate_security_config_writes("git add *")[0]
        assert not validate_security_config_writes("rm HUMAN*")[0]
        assert protected_config_target("*.md", glob=True) == "*.md"
