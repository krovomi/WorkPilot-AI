"""A list field a person wrote as one value stays one value.

Obsidian accepts ``agents: coder`` as well as ``agents: [coder]``. Read with
``list(value)``, the first became ``["c", "o", "d", "e", "r"]`` — and the next
write saved it that way. Each writer below once did that. (The graph already
reads these fields through its own `_str_list`.)
"""

from __future__ import annotations

from pathlib import Path

import pytest
from brain import Brain
from brain.memories import instructions, remember
from brain.notes import Note, listed, read_note, write_note


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (["a", "b"], ["a", "b"]),
        ("coder", ["coder"]),
        (3, [3]),
        (None, []),
        ("", []),
        ([], []),
    ],
)
def test_listed(value, expected):
    assert listed(value) == expected


def test_listed_returns_a_copy():
    value = ["a"]
    listed(value).append("b")
    assert value == ["a"]


@pytest.fixture
def brain(tmp_path, monkeypatch):
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    made = Brain(root)
    made.init()
    return made


def test_a_write_to_a_note_keeps_its_single_values(brain):
    rel = "knowledge/keys.md"
    write_note(
        brain.root,
        Note(
            path=Path(rel),
            meta={"title": "Keys", "agents": "coder", "tasks": "shop/001", "tags": "x"},
            body="Rotate keys.",
        ),
    )

    brain.write(
        "Keys",
        "Rotate keys monthly.",
        path=rel,
        agent="qa",
        task="shop/002",
        tags=["y"],
        sync=False,
    )

    meta = read_note(brain.root, rel).meta
    assert meta["agents"] == ["coder", "qa"]
    assert meta["tasks"] == ["shop/001", "shop/002"]
    assert meta["tags"] == ["x", "y"]


def test_reinforcing_an_instruction_keeps_its_single_values(tmp_path):
    root = tmp_path / "brain"
    first = remember(root, "Toujours répondre en français", agent_name="claude-code")
    note = read_note(root, first.rel)
    note.meta.update(agents="claude-code", sources="chat", tasks="shop/001")
    write_note(root, note)

    remember(
        root,
        "Réponds toujours en français",
        agent_name="codex",
        source="review",
        task="shop/002",
    )

    meta = read_note(root, first.rel).meta
    assert meta["agents"] == ["claude-code", "codex"]
    assert meta["sources"] == ["chat", "review"]
    assert meta["tasks"] == ["shop/001", "shop/002"]
    [only] = instructions(root)
    assert only.agents == ["claude-code", "codex"]
