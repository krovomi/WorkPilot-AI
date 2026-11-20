"""The memory journal read back from what two machines merged, and the routes
of the Memories tab on the paths a person does not take every day."""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from brain import Brain
from brain.lifecycle import api as lifecycle_api
from brain.lifecycle import arbitration, journal
from brain.notes import Note, write_note

BASE = "knowledge/projects/shop/memory"
PROJECT = "/home/me/code/shop"


def line(**data) -> str:
    return f"- x <!-- wp-lifecycle {json.dumps(data)} -->"


class TestJournal:
    def test_an_agent_type_is_named_in_the_sentence(self, tmp_path):
        entry = journal.append(
            tmp_path,
            BASE,
            journal.JournalEntry(
                action="create", actor="agent:coder", note=f"{BASE}/a.md"
            ),
            now=datetime(2026, 11, 1, tzinfo=UTC),
        )

        text = (journal.journal_dir(tmp_path, BASE) / "2026-11.md").read_text("utf-8")
        assert entry is not None and "par l'agent coder : `a.md`" in text

    @pytest.mark.parametrize(
        ("field", "value"), [("action", "explode"), ("reason_code", "because")]
    )
    def test_an_action_or_reason_outside_the_lists_is_refused(
        self, tmp_path, field, value
    ):
        entry = journal.JournalEntry(action="create", actor="user", note="a.md")
        setattr(entry, field, value)

        with pytest.raises(ValueError, match="unknown lifecycle"):
            journal.append(tmp_path, BASE, entry)

    def test_a_journal_that_cannot_be_written_is_logged(self, tmp_path, caplog):
        (tmp_path / "knowledge").write_text("a file", encoding="utf-8")

        written = journal.append(
            tmp_path,
            BASE,
            journal.JournalEntry(action="create", actor="user", note="a"),
        )

        assert written is None and "journal not written" in caplog.text

    def test_lines_merged_from_elsewhere_are_read_for_what_they_hold(self, tmp_path):
        folder = journal.journal_dir(tmp_path, BASE)
        folder.mkdir(parents=True)
        (folder / "2026-10.md").write_text(
            "\n".join(
                [
                    "# Journal",
                    "- a line a person wrote",
                    "- x <!-- wp-lifecycle {not json} -->",
                    "- x <!-- wp-lifecycle [1] -->",
                    line(action="explode", id="0"),
                    line(action="create", note="a.md", related="b.md", ts="1", id="1"),
                    line(action="create", note="a.md", ts="1", id="1"),
                    line(action="forget", note="b.md", related=["a.md", 3], ts="2"),
                    line(action="pin", note="c.md", ts="3"),
                ]
            ),
            encoding="utf-8",
        )
        (folder / "2026-11.md").mkdir()  # a folder named like a month

        entries = journal.read(tmp_path, BASE)

        assert [(e.action, e.id) for e in entries] == [
            ("pin", ""),
            ("forget", ""),
            ("create", "1"),
        ]
        assert entries[2].related == []
        assert entries[1].related == ["a.md"]
        assert [e.action for e in journal.read(tmp_path, BASE, note="a.md")] == [
            "forget",
            "create",
        ]

    def test_no_journal_yet_and_a_base_outside_the_vault(self, tmp_path):
        assert journal.read(tmp_path, BASE) == []
        assert journal.read(tmp_path, "../../elsewhere") == []


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@pytest.fixture
def vault(tmp_path, monkeypatch):
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    brain = Brain(root)
    brain.init()
    return brain


@pytest.fixture
def client(vault):
    from brain.api import router
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def post(client, route: str, **body) -> dict:
    return client.post(f"/api/brain/memory/{route}", json=body).json()


class TestRoutes:
    def test_without_a_project_or_a_brain(self, client, vault, monkeypatch):
        assert post(client, "forget")["code"] == "invalid"

        monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(vault.root.parent / "none"))
        assert post(client, "forget", project_dir=PROJECT)["code"] == "no-brain"

    @pytest.mark.parametrize(
        ("method", "route"),
        [
            ("get", "lifecycle"),
            ("get", "history"),
            ("post", "forget"),
            ("post", "restore"),
            ("post", "pin"),
            ("post", "conflicts/resolve"),
            ("post", "conflicts/suggest"),
        ],
    )
    def test_every_route_needs_a_project(self, client, method, route):
        url = f"/api/brain/memory/{route}"
        reply = (
            client.get(url) if method == "get" else client.post(url, json={})
        ).json()
        assert reply["code"] == "invalid"

    @pytest.mark.parametrize("route", ["forget", "restore", "pin"])
    def test_an_id_outside_the_memory_is_invalid(self, client, route):
        reply = post(client, route, project_dir=PROJECT, id="../../../etc/passwd")
        assert reply == {"success": False, "error": "invalid", "code": "invalid"}

    def test_the_history_of_an_id_outside_the_memory(self, client):
        reply = client.get(
            "/api/brain/memory/history",
            params={"project_dir": PROJECT, "id": "../../x.md"},
        ).json()
        assert reply["code"] == "invalid"

    @pytest.mark.parametrize("route", ["forget", "restore", "pin"])
    def test_an_unknown_note_is_a_refusal_with_its_code(self, client, route):
        reply = post(client, route, project_dir=PROJECT, id="gotchas/nothing.md")
        assert reply["success"] is False and reply["error"] == reply["code"]

    def test_the_lifecycle_view_purges_and_syncs(self, client, monkeypatch):
        synced: list[str] = []
        monkeypatch.setattr(lifecycle_api.store, "purge_expired", lambda *_a: 2)
        monkeypatch.setattr(
            lifecycle_api, "_sync", lambda _brain, message: synced.append(message)
        )

        reply = client.get(
            "/api/brain/memory/lifecycle", params={"project_dir": PROJECT, "limit": 0}
        ).json()

        assert reply["success"] and synced == [
            "brain: purge 2 forgotten memory note(s)"
        ]

    def test_a_sync_that_fails_after_a_decision_is_only_logged(
        self, vault, monkeypatch, caplog
    ):
        def offline(_message):
            raise subprocess.SubprocessError("no network")

        monkeypatch.setattr(vault, "after_write", offline)

        lifecycle_api._sync(vault, "brain: pin a memory note")

        assert "sync after a memory decision failed" in caplog.text

    def test_unpin_says_so_in_the_commit(self, client, vault, monkeypatch):
        rel = f"{BASE}/gotchas/x.md"
        write_note(vault.root, Note(path=Path(rel), meta={"pinned": True}, body="x"))
        synced: list[str] = []
        monkeypatch.setattr(lifecycle_api, "_sync", lambda _b, m: synced.append(m))

        reply = post(client, "pin", project_dir=PROJECT, id=rel, pinned=False)

        assert reply["success"] and synced == ["brain: unpin a memory note"]


class TestConflictRoutes:
    @pytest.fixture
    def queued(self, vault):
        for name, body in (("a", "Always lint first."), ("b", "Never lint first.")):
            write_note(
                vault.root,
                Note(path=Path(f"{BASE}/gotchas/{name}.md"), meta={}, body=body),
            )
        arbitration.review_pull(vault.root, [f"{BASE}/gotchas/b.md"], [])
        [item] = arbitration.open_conflicts(vault.root)
        return item

    def test_an_unknown_pair(self, client):
        assert (
            post(client, "conflicts/resolve", project_dir=PROJECT, conflict_id="x")[
                "code"
            ]
            == "not-found"
        )
        assert (
            post(client, "conflicts/suggest", project_dir=PROJECT, conflict_id="x")[
                "code"
            ]
            == "not-found"
        )

    def test_resolving_syncs_the_decision(self, client, queued, monkeypatch):
        synced: list[str] = []
        monkeypatch.setattr(lifecycle_api, "_sync", lambda _b, m: synced.append(m))

        reply = post(
            client,
            "conflicts/resolve",
            project_dir=PROJECT,
            conflict_id=queued["id"],
            choice="a",
        )

        assert reply["success"] and synced == ["brain: resolve a memory conflict"]

    def test_an_unknown_choice_is_refused_and_nothing_synced(
        self, client, queued, monkeypatch
    ):
        synced: list[str] = []
        monkeypatch.setattr(lifecycle_api, "_sync", lambda _b, m: synced.append(m))

        reply = post(
            client,
            "conflicts/resolve",
            project_dir=PROJECT,
            conflict_id=queued["id"],
            choice="both",
        )

        assert reply == {"success": False, "error": "invalid", "code": "invalid"}
        assert synced == []

    def test_a_suggestion_for_a_project_that_is_not_a_folder(self, client, queued):
        reply = post(
            client,
            "conflicts/suggest",
            project_dir=PROJECT,
            conflict_id=queued["id"],
        )

        assert reply["code"] == "invalid"

    def test_a_suggestion_from_the_provider(
        self, client, queued, tmp_path, monkeypatch
    ):
        import agent_runtime

        class Runtime:
            async def oneshot_completion(self, prompt, **kwargs):
                return '{"verdict": "contradiction", "prefer": "b"}'

        monkeypatch.setattr(agent_runtime, "_runtime", Runtime())
        project = tmp_path / "shop"
        project.mkdir()

        reply = post(
            client,
            "conflicts/suggest",
            project_dir=str(project),
            conflict_id=queued["id"],
        )

        assert reply["success"] and reply["opinion"]["prefer"] == "b"
