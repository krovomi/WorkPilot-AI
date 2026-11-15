"""Human review checkpoint between spec and build (review/reviewer.py,
review/formatters.py, review/diff_analyzer.py).

The spec folder, the review state file and the editor are real: the editor
is a small Python script given through $EDITOR. Only the interactive menu
and the keyboard are scripted.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from review import formatters, reviewer
from review.diff_analyzer import (
    extract_checkboxes,
    extract_table_rows,
    extract_title,
)
from review.reviewer import (
    ReviewChoice,
    open_file_in_editor,
    prompt_feedback,
    run_review_checkpoint,
)
from review.state import ReviewState

SPEC = """# Add dark mode

## Overview

Let people switch the whole app to a dark theme.
The choice is remembered per device.

## Workflow Type

**Type**: feature

## Files to Modify

| File | Change | Why |
|------|--------|-----|
| `src/theme.ts` | add tokens | colors |
| src/profile.ts | read choice | storage |
| a.ts | x | y |
| b.ts | x | y |
| c.ts | x | y |
| d.ts | x | y |
| e.ts | x | y |

## Files to Create

| File | Purpose |
|------|---------|
| `src/dark.css` | palette |

## Success Criteria

- [ ] Toggle in settings
- [X] Respects the OS preference when nothing was chosen yet, on every platform we ship
- [ ] c3
- [ ] c4
- [ ] c5
- [ ] c6
"""

PLAN = {
    "feature": "Dark mode",
    "services_involved": ["frontend"],
    "summary": {"parallelism": {"recommended_workers": 2}},
    "phases": [
        {
            "phase": 1,
            "name": "Tokens",
            "subtasks": [{"id": "1.1", "description": "tokens", "status": "completed"}],
        },
        {
            "phase": 2,
            "name": "Toggle",
            "subtasks": [
                {"id": "2.1", "description": "switch", "status": "completed"},
                {"id": "2.2", "description": "x" * 60, "status": "in_progress"},
                {"id": "2.3", "description": "persist"},
                {"id": "2.4", "description": "docs"},
            ],
        },
        {"phase": 3, "name": "Docs", "subtasks": [{"id": "3.1", "description": "d"}]},
    ],
}


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "001-dark-mode"
    folder.mkdir()
    (folder / "spec.md").write_text(SPEC, encoding="utf-8")
    (folder / "implementation_plan.json").write_text(json.dumps(PLAN), encoding="utf-8")
    return folder


@pytest.fixture
def editor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """$EDITOR = a script that appends a line to the file it is given."""
    script = tmp_path / "editor.py"
    script.write_text(
        "import sys\n"
        "with open(sys.argv[-1], 'a', encoding='utf-8') as f:\n"
        "    f.write('\\nedited\\n')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("EDITOR", f'"{sys.executable}" "{script}"')
    return script


def _menu(monkeypatch: pytest.MonkeyPatch, *choices: str | None) -> list[dict]:
    calls: list[dict] = []
    answers: Iterator[str | None] = iter(choices)

    def select_menu(**kwargs: object) -> str | None:
        calls.append(kwargs)
        return next(answers)

    monkeypatch.setattr(reviewer, "select_menu", select_menu)
    return calls


def _keys(monkeypatch: pytest.MonkeyPatch, *lines: str | type[BaseException]) -> None:
    feed = iter(lines)

    def fake_input(prompt: str = "") -> str:
        value = next(feed)
        if isinstance(value, type):
            raise value()
        return value

    monkeypatch.setattr("builtins.input", fake_input)


# --------------------------------------------------------------------------
# Markdown helpers
# --------------------------------------------------------------------------


def test_table_rows_keep_a_row_that_names_the_header_word() -> None:
    # Regression: "| src/profile.ts |" holds "file" and was read as the
    # header row of the "File" table, so the row vanished.
    rows = extract_table_rows(SPEC.split("## Files to Create")[0], "File")

    assert rows[:2] == [
        ("`src/theme.ts`", "add tokens", "colors"),
        ("src/profile.ts", "read choice", "storage"),
    ]
    assert len(rows) == 7


def test_table_rows_pad_two_columns_and_stop_at_prose() -> None:
    table = (
        "| File | Purpose |\n|---|---|\n| a.css | x |\n| one |\nAfter.\n| b.css | y |"
    )

    assert extract_table_rows(table, "file") == [("a.css", "x", "")]


def test_checkboxes_include_upper_case_x() -> None:
    assert extract_checkboxes("- [ ] a\n* [x] b\n- [X] c\n- [?] d") == ["a", "b", "c"]
    assert extract_title("no heading") == "Specification"


# --------------------------------------------------------------------------
# Summaries
# --------------------------------------------------------------------------


def test_spec_summary_shows_the_sections(
    spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    formatters.display_spec_summary(spec_dir)

    out = capsys.readouterr().out
    assert "Add dark mode" in out
    assert "Let people switch" in out
    assert "Workflow:" in out and "feature" in out
    assert "src/theme.ts" in out and "src/profile.ts" in out
    assert "... and 1 more" in out  # 7 files, 6 shown
    assert "+ src/dark.css" in out
    assert "Toggle in settings" in out
    assert "Respects the OS preference when nothing was chosen yet, on e..." in out
    assert "c6" not in out
    assert "... and 1 more" in out


def test_spec_summary_reports_a_missing_or_unreadable_spec(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    formatters.display_spec_summary(tmp_path)
    assert "spec.md not found" in capsys.readouterr().out

    (tmp_path / "spec.md").write_bytes(b"\xff\xfe")
    formatters.display_spec_summary(tmp_path)
    assert "Could not read spec.md" in capsys.readouterr().out


def test_spec_summary_of_a_bare_spec(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "spec.md").write_text("Some text\n", encoding="utf-8")

    formatters.display_spec_summary(tmp_path)

    out = capsys.readouterr().out
    assert "Specification" in out
    assert "Overview:" not in out and "Files to Modify:" not in out


def test_plan_summary_shows_phases_and_progress(
    spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    formatters.display_plan_summary(spec_dir)

    out = capsys.readouterr().out
    assert "Dark mode" in out
    assert "Phases: 3" in out
    assert "Subtasks: 2/6 completed" in out
    assert "Services: frontend" in out
    assert "Phase 1: Tokens (1/1 subtasks)" in out
    assert "Phase 2: Toggle (1/4 subtasks)" in out
    assert "Phase 3: Docs (0/1 subtasks)" in out
    assert "x" * 50 + "..." in out
    assert "... 1 more subtasks" in out
    assert "2 workers recommended" in out


def test_plan_summary_reports_a_missing_or_broken_plan(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    formatters.display_plan_summary(tmp_path)
    assert "implementation_plan.json not found" in capsys.readouterr().out

    (tmp_path / "implementation_plan.json").write_text("{", encoding="utf-8")
    formatters.display_plan_summary(tmp_path)
    assert "Could not read implementation_plan.json" in capsys.readouterr().out


def test_review_status_box_follows_the_state(
    spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    formatters.display_review_status(spec_dir)
    assert "NOT YET APPROVED" in capsys.readouterr().out

    state = ReviewState()
    state.add_feedback("Looks good but " + "y" * 70, spec_dir)
    state.approve(spec_dir, approved_by="leub")
    formatters.display_review_status(spec_dir)
    out = capsys.readouterr().out
    assert "APPROVED" in out and "leub" in out
    assert "Approved at:" in out
    assert "Review sessions:" in out
    assert "Looks good but" in out and "..." in out

    state.approved_at = "yesterday"
    state.save(spec_dir)
    formatters.display_review_status(spec_dir)
    assert "yesterday" in capsys.readouterr().out

    (spec_dir / "spec.md").write_text(SPEC + "\nchanged\n", encoding="utf-8")
    formatters.display_review_status(spec_dir)
    assert "APPROVAL STALE" in capsys.readouterr().out


# --------------------------------------------------------------------------
# Feedback and editor
# --------------------------------------------------------------------------


def test_feedback_ends_on_two_blank_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    _keys(monkeypatch, "first", "", "second", "", "")

    assert prompt_feedback() == "first\n\nsecond"


def test_feedback_cancelled_or_empty_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    _keys(monkeypatch, "draft", KeyboardInterrupt)
    assert prompt_feedback() is None

    _keys(monkeypatch, "  ", EOFError)
    assert prompt_feedback() is None


def test_editor_from_environment_edits_the_file(spec_dir: Path, editor: Path) -> None:
    spec = spec_dir / "spec.md"

    assert open_file_in_editor(spec) is True
    assert spec.read_text(encoding="utf-8").endswith("\nedited\n")


def test_editor_failures_are_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "x.md"
    assert open_file_in_editor(target) is False
    assert "File not found" in capsys.readouterr().out

    target.write_text("x", encoding="utf-8")
    monkeypatch.setenv("EDITOR", f'"{sys.executable}" -c "raise SystemExit(3)"')
    assert open_file_in_editor(target) is False
    assert "Editor failed" in capsys.readouterr().out

    monkeypatch.setenv("EDITOR", "workpilot-no-such-editor")
    assert open_file_in_editor(target) is False
    assert "Editor not found: workpilot-no-such-editor" in capsys.readouterr().out

    monkeypatch.setenv("EDITOR", '""')
    assert open_file_in_editor(target) is False
    assert 'Editor not found: ""' in capsys.readouterr().out


def test_without_editor_the_file_path_is_shown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "x.md"
    target.write_text("x", encoding="utf-8")
    monkeypatch.delenv("EDITOR", raising=False)
    monkeypatch.setattr(reviewer, "find_executable", lambda name: None)

    assert open_file_in_editor(target) is False
    assert "No editor found" in capsys.readouterr().out


def test_vs_code_found_on_path_is_asked_to_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "x.md"
    target.write_text("x", encoding="utf-8")
    monkeypatch.delenv("EDITOR", raising=False)
    monkeypatch.setattr(reviewer, "find_executable", lambda name: f"/bin/{name}")
    ran: list[list[str]] = []
    monkeypatch.setattr(
        reviewer.subprocess, "run", lambda argv, check: ran.append(argv)
    )

    assert open_file_in_editor(target) is True
    assert ran == [["code", "--wait", str(target)]]


# --------------------------------------------------------------------------
# The checkpoint
# --------------------------------------------------------------------------


def test_auto_approve_skips_the_menu(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _menu(monkeypatch)

    state = run_review_checkpoint(spec_dir, auto_approve=True)

    assert state.approved_by == "auto"
    assert ReviewState.load(spec_dir).is_approval_valid(spec_dir)
    assert calls == []


def test_valid_approval_is_kept(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ReviewState().approve(spec_dir, approved_by="leub")
    calls = _menu(monkeypatch)

    state = run_review_checkpoint(spec_dir)

    assert state.approved_by == "leub"
    assert "ALREADY APPROVED" in capsys.readouterr().out
    assert calls == []

    state.approved_at = "not a date"
    state.save(spec_dir)
    run_review_checkpoint(spec_dir)
    assert "Approved at:" not in capsys.readouterr().out


def test_feedback_edits_then_approval(
    spec_dir: Path,
    editor: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls = _menu(
        monkeypatch,
        ReviewChoice.FEEDBACK.value,
        ReviewChoice.FEEDBACK.value,
        ReviewChoice.EDIT_SPEC.value,
        ReviewChoice.EDIT_PLAN.value,
        ReviewChoice.APPROVE.value,
    )
    _keys(monkeypatch, "Split phase 2", "", "", EOFError)

    state = run_review_checkpoint(spec_dir)

    assert len(calls) == 5
    assert calls[0]["title"] == "Review Implementation Plan"
    assert len(state.feedback) == 1
    assert state.feedback[0].endswith("] Split phase 2")
    assert state.approved_by == "user"
    assert (spec_dir / "spec.md").read_text(encoding="utf-8").endswith("edited\n")
    assert (
        (spec_dir / "implementation_plan.json")
        .read_text(encoding="utf-8")
        .endswith("edited\n")
    )
    out = capsys.readouterr().out
    assert "HUMAN REVIEW CHECKPOINT" in out
    assert "Feedback saved." in out and "No feedback added." in out
    assert "spec.md updated" in out and "Implementation plan updated" in out
    assert "Spec approved!" in out


def test_changed_spec_drops_the_old_approval_and_edits_invalidate(
    spec_dir: Path,
    editor: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    state = ReviewState()
    state.approve(spec_dir, approved_by="leub")
    (spec_dir / "spec.md").write_text(SPEC + "\nmore\n", encoding="utf-8")
    seen: list[bool] = []

    def select_menu(**kwargs: object) -> str:
        seen.append(ReviewState.load(spec_dir).approved)
        return [ReviewChoice.EDIT_SPEC.value, ReviewChoice.REJECT.value][len(seen) - 1]

    monkeypatch.setattr(reviewer, "select_menu", select_menu)

    with pytest.raises(SystemExit) as exit_info:
        run_review_checkpoint(spec_dir)

    assert exit_info.value.code == 1
    assert seen == [False, False]
    out = capsys.readouterr().out
    assert "SPEC CHANGED SINCE APPROVAL" in out
    assert "SPEC REJECTED" in out


def test_editing_a_missing_file_is_refused(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    (spec_dir / "spec.md").unlink()
    (spec_dir / "implementation_plan.json").unlink()
    _menu(
        monkeypatch,
        ReviewChoice.EDIT_SPEC.value,
        ReviewChoice.EDIT_PLAN.value,
        ReviewChoice.APPROVE.value,
    )

    run_review_checkpoint(spec_dir)

    out = capsys.readouterr().out
    assert out.count("spec.md not found") >= 2
    assert out.count("implementation_plan.json not found") >= 2


def test_approved_state_is_invalidated_by_an_edit(
    spec_dir: Path, editor: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An approval recorded while the menu is open (another window) is
    # dropped by an edit, of the spec or of the plan.
    states: list[ReviewState] = []
    choices = iter(
        [
            ReviewChoice.EDIT_SPEC.value,
            ReviewChoice.EDIT_PLAN.value,
            ReviewChoice.APPROVE.value,
        ]
    )

    def select_menu(**kwargs: object) -> str:
        state = states[0]
        state.approved = True
        return next(choices)

    original_load = ReviewState.load

    def load(spec: Path) -> ReviewState:
        state = original_load(spec)
        states.append(state)
        return state

    monkeypatch.setattr(reviewer.ReviewState, "load", staticmethod(load))
    monkeypatch.setattr(reviewer, "select_menu", select_menu)

    final = run_review_checkpoint(spec_dir)

    assert final.approved_by == "user"


@pytest.mark.parametrize("exit_by", ["quit", "ctrl-c"])
def test_quitting_saves_the_state(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch, exit_by: str
) -> None:
    if exit_by == "quit":
        _menu(monkeypatch, None)
    else:

        def select_menu(**kwargs: object) -> str:
            raise KeyboardInterrupt

        monkeypatch.setattr(reviewer, "select_menu", select_menu)

    with pytest.raises(SystemExit) as exit_info:
        run_review_checkpoint(spec_dir)

    assert exit_info.value.code == 0
    assert (spec_dir / "review_state.json").exists()
