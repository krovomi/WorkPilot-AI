"""``/api/brain/memory/*``: what the desktop's Memories tab calls.

The project is a name read out of ``project_dir``; a memory is its vault path,
checked before any file is opened; server mode refuses the whole surface.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from brain import Brain
from brain.lifecycle import journal
from brain.project_memory import ProjectMemory

BASE = Path("knowledge/projects/shop/memory")
REL = (BASE / "gotchas" / "never-push-on-friday.md").as_posix()


@pytest.fixture
def client(tmp_path, monkeypatch):
    from brain.api import router
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    brain = Brain(root)
    brain.init()
    ProjectMemory(project="shop", brain=brain).record_gotcha("Never push on Friday.")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


PROJECT = "/home/me/code/shop"


def test_forget_restore_pin_and_the_journal_through_the_api(client):
    got = client.post(
        "/api/brain/memory/pin",
        json={"project_dir": PROJECT, "id": REL, "pinned": True},
    ).json()
    assert got["success"] and got["count"] == 1

    got = client.post(
        "/api/brain/memory/forget",
        json={"project_dir": PROJECT, "id": REL, "reason": "We ship on Fridays now."},
    ).json()
    assert got["success"] and got["trash_id"] == "gotchas/never-push-on-friday.md"

    view = client.get(
        "/api/brain/memory/lifecycle", params={"project_dir": PROJECT}
    ).json()
    assert view["success"] and view["pin_limit"] == 50
    assert [t["id"] for t in view["trash"]] == ["gotchas/never-push-on-friday.md"]
    assert view["journal"][0]["reason"] == "We ship on Fridays now."
    assert view["conflicts"] == []

    got = client.post(
        "/api/brain/memory/restore",
        json={"project_dir": PROJECT, "id": "gotchas/never-push-on-friday.md"},
    ).json()
    assert got["success"] and got["path"] == REL

    history = client.get(
        "/api/brain/memory/history", params={"project_dir": PROJECT, "id": REL}
    ).json()
    assert [e["action"] for e in history["entries"]] == [
        "restore",
        "forget",
        "pin",
        "create",
    ]


@pytest.mark.parametrize(
    "hostile",
    [
        "../../../../etc/passwd",
        "knowledge/projects/other/memory/gotchas/x.md",
        "/etc/hosts.md",
        "gotchas/../../index.md",
    ],
)
def test_a_hostile_id_is_refused(client, hostile):
    for route in ("forget", "restore", "pin"):
        got = client.post(
            f"/api/brain/memory/{route}", json={"project_dir": PROJECT, "id": hostile}
        ).json()
        assert got == {"success": False, "error": "invalid", "code": "invalid"}
    got = client.get(
        "/api/brain/memory/history", params={"project_dir": PROJECT, "id": hostile}
    ).json()
    assert got["code"] == "invalid"


def test_an_unknown_conflict_is_not_found(client):
    for route in ("resolve", "suggest"):
        got = client.post(
            f"/api/brain/memory/conflicts/{route}",
            json={"project_dir": PROJECT, "conflict_id": "nope", "choice": "a"},
        ).json()
        assert got["code"] == "not-found"


def test_server_mode_refuses_the_whole_surface(client, monkeypatch):
    import brain.lifecycle.api as api

    monkeypatch.setattr(api, "server_mode_roots", lambda: [Path("/srv")])
    got = client.get(
        "/api/brain/memory/lifecycle", params={"project_dir": PROJECT}
    ).json()
    assert got["reason"] == "server-mode"
    got = client.post(
        "/api/brain/memory/forget", json={"project_dir": PROJECT, "id": REL}
    ).json()
    assert got["reason"] == "server-mode"
    assert journal.read(Brain().root, BASE)[0].action == "create"
