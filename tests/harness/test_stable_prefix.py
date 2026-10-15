"""Lot 2: what tasks and subtasks share comes first in the prompts they send.

Every provider that caches a prompt caches a prefix, so a byte that differs
early is billed again with everything after it. The worktree's path used to be
the second sentence of the shared system prompt, and the per-task sections of
a coding prompt came after the subtask's own text: two tasks shared one
sentence, two subtasks of one task shared nothing past the environment header.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from core.llm_optimization import build_base_system_prompt, system_prompt_segments
from harness.domain.layout import Segment, Stability, assemble, shared_prefix


@pytest.fixture
def two_worktrees(tmp_path: Path) -> tuple[Path, Path]:
    first = tmp_path / "worktrees" / "001-login"
    second = tmp_path / "worktrees" / "002-billing"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    return first, second


@pytest.mark.parametrize("hint", [False, True])
def test_two_tasks_send_the_same_system_prompt_up_to_their_path(two_worktrees, hint):
    first, second = (
        build_base_system_prompt(worktree, tool_use_hint=hint)
        for worktree in two_worktrees
    )
    first_tail = f"\n\nYour working directory is: {two_worktrees[0].resolve()}"
    second_tail = f"\n\nYour working directory is: {two_worktrees[1].resolve()}"
    assert first.endswith(first_tail) and second.endswith(second_tail)
    assert first.removesuffix(first_tail) == second.removesuffix(second_tail)


def test_the_path_is_the_only_task_segment_and_it_comes_last(tmp_path):
    segments = [s for s in system_prompt_segments(tmp_path) if s.text]
    assert segments[-1].name == "working_directory"
    assert [s.name for s in segments if s.stability >= Stability.TASK] == [
        "working_directory"
    ]
    prompt = build_base_system_prompt(tmp_path)
    assert str(tmp_path.resolve()) not in shared_prefix(
        segments, up_to=Stability.PROJECT
    )
    assert prompt.count(str(tmp_path.resolve())) == 1


def test_the_rules_still_name_the_working_directory(tmp_path):
    prompt = build_base_system_prompt(tmp_path)
    assert "RESTRICTED to your working directory, given at the end of this prompt" in (
        prompt
    )


def _coding_prompt(project: Path, spec: Path, subtask_text: str) -> str:
    from agents.coder import _coding_task_segments

    return assemble(
        [
            *_coding_task_segments(
                project, spec, "EFFORT: high\nWORKFLOW PHASE: coding"
            ),
            Segment("subtask", subtask_text, Stability.SESSION),
        ]
    )


def test_two_subtasks_share_the_task_block(tmp_path, monkeypatch):
    import agents.coder as coder

    monkeypatch.setattr(coder, "constitution_section", lambda _p: "CONSTITUTION")
    monkeypatch.setattr(coder, "mobile_section", lambda _p: "")
    monkeypatch.setattr(coder, "docintel_section", lambda _p, _s: "ADRS")
    monkeypatch.setattr(
        coder, "workflow_reports_section", lambda _s, _phase, inline=True: "REPORTS"
    )
    first = _coding_prompt(tmp_path, tmp_path, "# Subtask 1")
    second = _coding_prompt(tmp_path, tmp_path, "# Subtask 2")
    block = (
        "CONSTITUTION\n\nEFFORT: high\nWORKFLOW PHASE: coding\n\nADRS\n\nREPORTS\n\n"
    )
    assert first == block + "# Subtask 1"
    assert second == block + "# Subtask 2"


def test_an_absent_section_leaves_no_blank_lines(tmp_path, monkeypatch):
    import agents.coder as coder

    for name in ("constitution_section", "mobile_section"):
        monkeypatch.setattr(coder, name, lambda _p: "")
    monkeypatch.setattr(coder, "docintel_section", lambda _p, _s: "")
    monkeypatch.setattr(
        coder, "workflow_reports_section", lambda _s, _phase, inline=True: ""
    )
    assert _coding_prompt(tmp_path, tmp_path, "# Subtask 1") == (
        "EFFORT: high\nWORKFLOW PHASE: coding\n\n# Subtask 1"
    )
