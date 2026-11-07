"""Steering a running task (killer feature F1): ``steering.jsonl``.

The queue is a log both sides append to; reading takes the union of the spec
copies; the next session it applies to receives a message, which WorkPilot
then marks delivered; a targeted message waits for its subtask; an agent
cannot write the file; the CLI and the server route queue the same way.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from foundation.human_input import write_human_input
from foundation.steering import (
    MAX_STEERING_CHARS,
    STEERING_FILE,
    PersonNotes,
    add_message,
    clean_text,
    deliver_notes,
    load_messages,
    mark_delivered,
    pending,
    person_notes,
    steering_section,
)
from security.path_guard import protected_config_refusal, protected_config_target

NOW = datetime(2026, 11, 6, 20, 0, tzinfo=UTC)


def _copies(tmp_path: Path) -> tuple[Path, Path]:
    main = tmp_path / "project" / ".workpilot" / "specs" / "001-x"
    worktree = (
        tmp_path / "project/.workpilot/worktrees/tasks/001-x/.workpilot/specs/001-x"
    )
    main.mkdir(parents=True)
    worktree.mkdir(parents=True)
    return main, worktree


# ── the queue ────────────────────────────────────────────────────────────────


def test_a_message_is_written_in_every_copy_and_read_once(tmp_path):
    main, worktree = _copies(tmp_path)
    message = add_message(
        "Use the existing repository", main, worktree, source="desktop"
    )
    for copy in (main, worktree):
        lines = (copy / STEERING_FILE).read_text(encoding="utf-8").splitlines()
        assert json.loads(lines[0])["id"] == message.id
    [read] = load_messages(main, worktree)
    assert read.text == "Use the existing repository" and not read.delivered


def test_a_message_or_delivery_in_one_copy_only_still_counts(tmp_path):
    main, worktree = _copies(tmp_path)
    first = add_message("one", main, source="desktop", now=NOW)
    second = add_message("two", worktree, source="cli", now=NOW)
    mark_delivered([first], worktree, session=3, subtask_id="subtask-1", now=NOW)
    messages = {m.text: m for m in load_messages(main, worktree)}
    assert messages["one"].delivered and messages["one"].delivered_session == 3
    assert messages["one"].delivered_subtask_id == "subtask-1"
    assert not messages["two"].delivered
    assert [m.id for m in pending(load_messages(main, worktree), "subtask-2")] == [
        second.id
    ]


def test_a_delivered_message_is_not_sent_again(tmp_path):
    main, worktree = _copies(tmp_path)
    add_message("rename the endpoint", main, worktree, source="desktop")
    notes = person_notes(worktree, main, "subtask-1")
    assert len(notes.steering) == 1
    deliver_notes(notes, worktree, main, session=4)
    assert person_notes(worktree, main, "subtask-2").steering == ()
    [message] = load_messages(main, worktree)
    assert message.delivered_session == 4


def test_a_targeted_message_waits_for_its_subtask(tmp_path):
    main, worktree = _copies(tmp_path)
    add_message(
        "this one only", main, worktree, source="desktop", target_subtask_id="subtask-2"
    )
    assert pending(load_messages(main, worktree), "subtask-1") == ()
    assert pending(load_messages(main, worktree), None) == ()  # nor the QA fixer
    [due] = pending(load_messages(main, worktree), "subtask-2")
    assert due.text == "this one only"


def test_appends_from_two_writers_are_both_kept(tmp_path):
    main, _ = _copies(tmp_path)
    a = add_message("from the app", main, source="desktop")
    mark_delivered([a], main, session=1, subtask_id=None)
    b = add_message("from the CLI", main, source="cli")
    lines = (main / STEERING_FILE).read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["type"] for line in lines] == [
        "message",
        "delivered",
        "message",
    ]
    assert {m.id for m in load_messages(main)} == {a.id, b.id}


def test_a_line_cut_by_a_crash_does_not_lose_the_others(tmp_path):
    main, _ = _copies(tmp_path)
    add_message("kept", main, source="desktop")
    with open(main / STEERING_FILE, "a", encoding="utf-8") as f:
        f.write('{"type": "message", "id": "x", "te')
    assert [m.text for m in load_messages(main)] == ["kept"]


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"text": "   "}, "empty_message"),
        ({"text": "​‮"}, "empty_message"),
        ({"text": "ok", "source": "agent"}, "unknown_source"),
        ({"text": "ok", "target_subtask_id": "../x"}, "invalid_subtask"),
    ],
)
def test_invalid_messages_are_refused(tmp_path, kwargs, code):
    main, _ = _copies(tmp_path)
    args = {"source": "desktop", **kwargs}
    text = args.pop("text")
    with pytest.raises(ValueError, match=code):
        add_message(text, main, **args)
    assert not (main / STEERING_FILE).exists()


def test_text_from_a_phone_loses_invisible_characters_and_is_bounded():
    assert clean_text("do​ this‮\nthen\tthat\x07") == "do this\nthen\tthat"
    assert len(clean_text("x" * (MAX_STEERING_CHARS + 10))) == MAX_STEERING_CHARS


# ── the prompts ──────────────────────────────────────────────────────────────


def test_the_subtask_prompt_carries_the_queue_after_human_input(tmp_path):
    from prompts_pkg.prompt_generator import generate_subtask_prompt

    main, worktree = _copies(tmp_path)
    write_human_input("Stop using mocks", main, worktree)
    add_message("Keep the public API unchanged", main, worktree, source="desktop")
    notes = person_notes(worktree, main, "subtask-1")
    prompt = generate_subtask_prompt(
        spec_dir=worktree,
        project_dir=tmp_path / "project",
        subtask={"id": "subtask-1", "description": "Add the endpoint"},
        phase={},
        human_input=notes,
    )
    human = prompt.index("Stop using mocks")
    steer = prompt.index("Keep the public API unchanged")
    assert human < steer
    assert "Messages from the person" in prompt


def test_a_string_still_works_as_before():
    assert (
        PersonNotes(human="x")
        .sections()[0]
        .startswith("## Instructions from the person")
    )
    assert steering_section(()) == ""


def test_delivering_notes_archives_human_input_and_marks_the_queue(tmp_path):
    main, worktree = _copies(tmp_path)
    write_human_input("Once", main, worktree)
    add_message("And this", main, worktree, source="cli")
    notes = person_notes(worktree, main, "subtask-1")
    deliver_notes(notes, worktree, main, session=2)
    assert not (main / "HUMAN_INPUT.md").exists()
    assert all(m.delivered for m in load_messages(main, worktree))
    deliver_notes("", worktree, main, session=3)  # a planner session: nothing to do


# ── what an agent may not write ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "steering.jsonl",
        ".workpilot/specs/001-x/steering.jsonl",
        "STEERING.JSONL",
    ],
)
def test_an_agent_cannot_write_the_queue(path, tmp_path):
    assert protected_config_target(path) is not None
    reason = protected_config_refusal(path, tmp_path)
    assert reason and "messages the person sends" in reason


# ── the CLI ──────────────────────────────────────────────────────────────────


def test_cli_steer_queues_in_both_copies(tmp_path):
    from cli.steer_command import handle_steer_command

    main, worktree = _copies(tmp_path)
    assert handle_steer_command(
        tmp_path / "project", main, "Prefer records", "subtask-3"
    )
    for copy in (main, worktree):
        [message] = load_messages(copy)
        assert message.source == "cli" and message.target_subtask_id == "subtask-3"
    assert not handle_steer_command(tmp_path / "project", main, "  ")


def test_cli_parser_takes_steer_with_a_subtask():
    from cli.main import parse_args

    args = parse_args(["--spec", "001", "--steer", "hello", "--steer-subtask", "s-1"])
    assert args.steer == "hello" and args.steer_subtask == "s-1"
