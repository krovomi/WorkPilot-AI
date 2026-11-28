"""The tickets of a server project's board, read from its clone."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from board_ask import tickets as tk
from board_ask.tickets import Ticket


def _card(root: Path, card_id: str, plan=None, requirements=None, meta=None, spec=None):
    directory = root / ".workpilot" / "specs" / card_id
    directory.mkdir(parents=True)
    for name, value in (
        ("implementation_plan.json", plan),
        ("requirements.json", requirements),
        ("task_metadata.json", meta),
    ):
        if value is not None:
            text = value if isinstance(value, str) else json.dumps(value)
            (directory / name).write_text(text, encoding="utf-8")
    if spec is not None:
        (directory / "spec.md").write_text(spec, encoding="utf-8")
    return directory


def _write(root: Path, relative: str, value) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_a_card_is_read_with_its_plan_spec_and_state(tmp_path):
    _card(
        tmp_path,
        "001-admin",
        plan={
            "feature": "Admin page",
            "status": "done",
            "updated_at": "2026-11-01T10:00:00Z",
            "phases": [
                "not a phase",
                {
                    "subtasks": [
                        "not a subtask",
                        {
                            "title": "Rework",
                            "description": "the page",
                            "files_to_modify": ["src/AdminPage.tsx", 3],
                        },
                        {"description": "", "files": ["src/AdminPage.tsx", "src/b.ts"]},
                    ]
                },
            ],
        },
        requirements={"task_description": "Review the admin page"},
        meta={"archivedAt": "2026-11-02"},
        spec="# Spec\n\n## Goal\nBetter admin.\n",
    )
    [ticket] = tk.card_tickets(tmp_path)
    assert ticket == Ticket(
        id="001-admin",
        title="Admin page",
        description="Review the admin page",
        spec="Spec Goal Better admin.",
        subtasks=["Rework the page"],
        files=["src/AdminPage.tsx", "src/b.ts"],
        state="done",
        updated_at="2026-11-01T10:00:00Z",
        archived=True,
    )


@pytest.mark.parametrize(
    "plan, meta, state",
    [
        ({"status": "human_review", "reviewReason": "qa_rejected"}, {}, "failed"),
        ({"status": "human_review"}, {}, "in_review"),
        ({"status": "in_progress"}, {}, "in_progress"),
        ({"status": "error"}, {}, "failed"),
        ({"status": "backlog"}, {"abandoned": True}, "abandoned"),
        ({}, {}, "planned"),
    ],
)
def test_where_a_card_stands(tmp_path, plan, meta, state):
    _card(tmp_path, "002-x", plan={"feature": "X", **plan}, meta=meta)
    assert tk.card_tickets(tmp_path)[0].state == state


def test_unreadable_files_leave_their_fields_empty(tmp_path):
    directory = _card(tmp_path, "003-y", plan="{not json", requirements="[1]")
    (directory / "spec.md").mkdir()
    big = directory / "task_metadata.json"
    big.write_text("x" * (tk.JSON_BYTES + 1), encoding="utf-8")
    [ticket] = tk.card_tickets(tmp_path)
    assert (ticket.title, ticket.description, ticket.spec, ticket.archived) == (
        "003-y",
        "",
        "",
        False,
    )


def test_unreadable_spec_is_left_out(tmp_path, monkeypatch):
    directory = _card(tmp_path, "004-z", plan={"feature": "Z"}, spec="hello")

    def refuse(*_a, **_k):
        raise OSError("denied")

    monkeypatch.setattr(Path, "open", refuse)
    assert tk._spec_opening(directory) == ""


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs links")
def test_links_and_strangers_are_not_read(tmp_path):
    outside = tmp_path / "outside"
    _card(outside, "009-secret", plan={"feature": "Secret"}, spec="secret")
    root = tmp_path / "clone"
    good = _card(root, "001-ok", plan={"feature": "Ok"})
    specs = root / ".workpilot" / "specs"
    (specs / "not-a-card").mkdir()
    (specs / "005-file").write_text("x", encoding="utf-8")
    try:
        (specs / "010-linked").symlink_to(
            outside / ".workpilot" / "specs" / "009-secret", target_is_directory=True
        )
        (good / "spec.md").symlink_to(
            outside / ".workpilot" / "specs" / "009-secret" / "spec.md"
        )
        (good / "requirements.json").symlink_to(outside / "nothing.json")
    except OSError:
        pytest.skip("links are not allowed here")
    assert [(t.id, t.spec) for t in tk.card_tickets(root)] == [("001-ok", "")]

    linked_root = tmp_path / "linked"
    (linked_root / ".workpilot").mkdir(parents=True)
    (linked_root / ".workpilot" / "specs").symlink_to(specs, target_is_directory=True)
    assert tk.card_tickets(linked_root) == []


def test_no_board_no_cards_and_the_count_is_bounded(tmp_path, monkeypatch):
    assert tk.card_tickets(tmp_path) == []
    for i in range(3):
        _card(tmp_path, f"00{i}-c", plan={"feature": f"C{i}"})
    monkeypatch.setattr(tk, "MAX_CARDS", 2)
    assert [t.id for t in tk.card_tickets(tmp_path)] == ["002-c", "001-c"]


def test_the_roadmap_and_the_ideas_not_yet_cards(tmp_path):
    _card(tmp_path, "001-made", plan={"feature": "Made"})
    _write(
        tmp_path,
        ".workpilot/roadmap/roadmap.json",
        {
            "features": [
                {
                    "id": "f1",
                    "title": "Export",
                    "description": "CSV",
                    "status": "done",
                    "acceptance_criteria": ["a"],
                },
                {"id": "f2", "title": "Search", "status": "in_progress"},
                {"id": "f3", "title": "Later"},
                {"id": "f4", "title": "Already a card", "linked_spec_id": "001-made"},
                {"id": "f5", "title": "Linked elsewhere", "linked_spec_id": "999-gone"},
                {"id": "", "title": "No id"},
                {"id": "f6", "title": ""},
            ]
        },
    )
    _write(
        tmp_path,
        ".workpilot/ideation/ideation.json",
        {
            "ideas": [
                {"id": "i1", "title": "Dark mode", "status": "draft"},
                {"id": "i2", "title": "Dropped", "status": "dismissed"},
                {"id": "i3", "title": "Shelved", "status": "archived"},
                {"id": "i4", "title": "Made", "linked_task_id": "001-made"},
                {"id": "i5", "title": "Gone", "linked_task_id": "999-gone"},
                {"id": "", "title": "No id"},
            ]
        },
    )
    tickets = {t.id: t for t in tk.board_tickets(tmp_path)}
    assert sorted(tickets) == [
        "001-made",
        "idea:i1",
        "idea:i2",
        "idea:i3",
        "idea:i5",
        "roadmap:f1",
        "roadmap:f2",
        "roadmap:f3",
        "roadmap:f5",
    ]
    assert (tickets["roadmap:f1"].state, tickets["roadmap:f1"].subtasks) == (
        "done",
        ["a"],
    )
    assert tickets["roadmap:f2"].state == "in_progress"
    assert tickets["roadmap:f3"].state == "planned"
    assert tickets["roadmap:f1"].kind == "roadmap" and tickets["idea:i1"].kind == "idea"
    assert (tickets["idea:i2"].state, tickets["idea:i2"].archived) == (
        "abandoned",
        False,
    )
    assert (tickets["idea:i3"].state, tickets["idea:i3"].archived) == (
        "abandoned",
        True,
    )


def test_no_clone_no_tickets(tmp_path):
    assert tk.board_tickets(tmp_path / "none") == []


def test_what_the_search_and_the_model_read_of_a_ticket():
    ticket = Ticket(
        id="t1",
        title="Admin",
        description="Review   the\npage",
        spec="spec text",
        subtasks=["step one"],
        files=["src/AdminPage.tsx"],
        state="done",
        updated_at="2026-11-01T10:00:00Z",
        archived=True,
        kind="roadmap",
    )
    document = tk.ticket_document(ticket)
    assert document.id == "t1"
    assert document.fields[-1].text == "src/Admin Page.tsx"
    digest = tk.ticket_digest(ticket, 1000)
    assert digest.splitlines() == [
        "Title: Admin",
        "Kind: roadmap feature",
        "State: done (archived), last change 2026-11-01",
        "Description: Review the page",
        "Spec: spec text",
        "Steps: step one",
        "Files: src/AdminPage.tsx",
    ]
    short = tk.ticket_digest(ticket, 20)
    assert len(short) == 20 and short.endswith("…")
    assert (
        tk.ticket_digest(Ticket(id="t2", title="B"), 100) == "Title: B\nState: planned"
    )


def test_a_source_behind_a_link_or_not_a_list_is_left_out(tmp_path):
    outside = tmp_path / "outside"
    _write(
        outside, "roadmap/roadmap.json", {"features": [{"id": "f", "title": "Leak"}]}
    )
    root = tmp_path / "clone"
    (root / ".workpilot").mkdir(parents=True)
    _write(root, ".workpilot/ideation/ideation.json", {"ideas": {"id": "i"}})
    try:
        (root / ".workpilot" / "roadmap").symlink_to(
            outside / "roadmap", target_is_directory=True
        )
    except OSError:
        pytest.skip("links are not allowed here")
    assert tk.source_tickets(root, set()) == []


def test_a_rich_roadmap_feature_and_idea(tmp_path):
    _write(
        tmp_path,
        ".workpilot/roadmap/roadmap.json",
        {
            "features": [
                {
                    "id": "f",
                    "title": "Export",
                    "rationale": "why",
                    "acceptance_criteria": ["a", "", 1],
                    "user_stories": ["as a PO"],
                }
            ]
        },
    )
    _write(
        tmp_path,
        ".workpilot/ideation/ideation.json",
        {
            "ideas": [
                {
                    "id": "i",
                    "title": "Idea",
                    "rationale": "because",
                    "affected_files": ["src/a.ts"],
                }
            ]
        },
    )
    feature, idea = tk.source_tickets(tmp_path, set())
    assert (feature.spec, feature.subtasks) == ("why", ["a", "1", "as a PO"])
    assert (idea.spec, idea.files) == ("because", ["src/a.ts"])
