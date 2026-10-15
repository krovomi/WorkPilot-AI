"""The brain reads a long note or skill a page at a time, never a cut middle.

`brain_read_note` is level 3 of the recall ladder, "one note, in full". An MCP
client caps what it keeps of a tool result (Claude Code at 25,000 tokens,
WorkPilot's own loops at their result cap) and its cut drops the middle; the
server now pages the text itself and says which offset reads on.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from brain import Brain
from brain.mcp_server import (
    MCP_OUTPUT_TOKENS_ENV,
    READ_MAX_CHARS,
    TOOLS,
    _call,
    read_max_chars,
)
from brain.notes import Note, write_note

LONG_BODY = "".join(f"fact {n}: the cache key is per tenant\n" for n in range(1, 4001))


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv(MCP_OUTPUT_TOKENS_ENV, raising=False)


@pytest.fixture
def brain(tmp_path: Path) -> Brain:
    brain = Brain(tmp_path / "brain")
    write_note(
        brain.root, Note(Path("knowledge/long.md"), {"title": "Long"}, LONG_BODY)
    )
    write_note(
        brain.root, Note(Path("knowledge/short.md"), {"title": "Short"}, "TTL 5 min\n")
    )
    skill = brain.root / "skills" / "big-skill" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(LONG_BODY, encoding="utf-8")
    return brain


def test_a_short_note_comes_back_whole(brain):
    note = _call(brain, "brain_read_note", {"path": "knowledge/short.md"})
    assert note["body"] == brain.read("knowledge/short.md")["body"]


def test_a_long_note_comes_a_page_at_a_time_and_every_line_is_reachable(brain):
    seen: list[str] = []
    offset = 1
    for _ in range(100):
        body = _call(
            brain,
            "brain_read_note",
            {"path": "knowledge/long.md", "offset": offset},
            max_chars=20_000,
        )["body"]
        assert len(body) <= 20_000
        text, note = body.rsplit("\n", 1)
        seen.extend(text.splitlines())
        if "offset=" not in note:
            break
        offset = int(note.split("offset=")[1].rstrip("]"))
    assert seen == LONG_BODY.splitlines()


def test_a_long_skill_pages_the_same_way(brain):
    first = _call(brain, "brain_skill", {"name": "big-skill"}, max_chars=5_000)
    assert len(first) <= 5_000
    assert "To read on, call again with offset=" in first
    listed = _call(brain, "brain_skill", {})
    assert listed == ["big-skill"]


def test_offset_and_limit_accept_strings(brain):
    body = _call(
        brain,
        "brain_read_note",
        {"path": "knowledge/long.md", "offset": "10", "limit": "2"},
    )["body"]
    assert body.startswith("fact 10: ") and "fact 12: " not in body


def test_the_schemas_offer_the_page_arguments():
    tools = {tool["name"]: tool for tool in TOOLS}
    for name in ("brain_read_note", "brain_skill"):
        assert {"offset", "limit"} <= set(tools[name]["inputSchema"]["properties"])


@pytest.mark.parametrize(
    ("tokens", "expected"),
    [
        (None, READ_MAX_CHARS),
        ("25000", READ_MAX_CHARS),  # Claude Code's default: the page fits under it
        ("4000", 12_000),
        ("10", 1_000),  # never a page too small to hold a line
        ("not a number", READ_MAX_CHARS),
    ],
)
def test_a_page_fits_under_the_client_cap(monkeypatch, tokens, expected):
    if tokens is not None:
        monkeypatch.setenv(MCP_OUTPUT_TOKENS_ENV, tokens)
    assert read_max_chars() == expected


def test_the_in_process_path_pages_under_the_callers_cap(brain, monkeypatch):
    import brain.vault as vault
    from brain import runtime

    monkeypatch.setattr(vault, "Brain", lambda: brain)
    text = asyncio.run(
        runtime.execute_tool(
            "brain_read_note", {"path": "knowledge/long.md"}, max_chars=3_000
        )
    )
    body = json.loads(text)["body"]
    assert len(body) <= 3_000
    assert "offset=" in body
