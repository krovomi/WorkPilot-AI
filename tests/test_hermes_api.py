"""The hermes panel's HTTP routes, on a checkout and a hermes home of their own.

The router answers about ``_REPO_ROOT`` (this checkout) and ``$HERMES_HOME``;
both are moved to a temporary folder so nothing here touches the repository
or the machine's hermes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import hermes.api as api

    root = tmp_path / "checkout"
    (root / "skills" / "_proposed").mkdir(parents=True)
    home = tmp_path / "hermes-home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("PATH", str(tmp_path / "no-bin"))
    monkeypatch.setattr(api, "_REPO_ROOT", root)
    monkeypatch.setattr(api, "server_mode_roots", lambda: None)
    return root


@pytest.fixture
def client(repo: Path) -> TestClient:
    from hermes.api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _soul(repo: Path, text: str) -> Path:
    from hermes.soul import SOUL_RELATIVE_PATH

    path = repo / SOUL_RELATIVE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_without_hermes_the_status_says_so_and_lists_nothing(client) -> None:
    answer = client.get("/api/hermes/status", params={"fresh": True}).json()

    assert answer["success"] is True
    status = answer["status"]
    assert status["readiness"]["installed"] is False
    assert status["candidates"] == []
    assert status["pending"] == [] and status["stale"] == 0
    assert status["adopted"] == [] and status["declined"] == 0
    assert {s["id"] for s in status["surfaces"]} >= {"kanban"}


def test_a_cycle_without_hermes_proposes_nothing(client, repo: Path) -> None:
    answer = client.post("/api/hermes/cycle", json={"surface": "nowhere"}).json()

    assert answer["success"] is True
    assert answer["cycle"]["pending"] == []
    assert list((repo / "skills" / "_proposed").iterdir()) == []


def test_the_persona_is_installed_once_then_kept(client, repo: Path) -> None:
    _soul(repo, "I am the WorkPilot persona.")
    home = Path(__import__("os").environ["HERMES_HOME"])

    first = client.post("/api/hermes/soul/install", json={}).json()
    again = client.post("/api/hermes/soul/install", json={}).json()

    assert (first["success"], first["changed"], first["message"]) == (
        True,
        True,
        "installed",
    )
    assert first["sessions"] == "unavailable"  # no hermes binary to ask
    assert (home / "SOUL.md").read_text(encoding="utf-8").strip() == (
        "I am the WorkPilot persona."
    )
    assert first["soul"]["matches"] is True
    assert (again["changed"], again["sessions"]) == (False, None)
    assert again["message"] == "already installed and identical"


def test_a_different_persona_is_replaced_only_when_asked(client, repo: Path) -> None:
    _soul(repo, "new persona")
    home = Path(__import__("os").environ["HERMES_HOME"])
    home.mkdir(parents=True)
    (home / "SOUL.md").write_text("their own persona", encoding="utf-8")

    kept = client.post("/api/hermes/soul/install", json={}).json()
    replaced = client.post("/api/hermes/soul/install", json={"overwrite": True}).json()

    assert kept["changed"] is False and "already installed" in kept["message"]
    assert replaced["changed"] is True
    [backup] = home.glob("SOUL.*.bak.md")
    assert backup.read_text(encoding="utf-8").strip() == "their own persona"


def test_a_review_with_an_unknown_decision_is_refused(client) -> None:
    answer = client.post(
        "/api/hermes/review", json={"files": [], "decision": "maybe"}
    ).json()

    assert answer == {"success": False, "error": "decision is 'adopt' or 'decline'"}


def test_a_review_skips_a_name_that_is_not_a_candidate(client) -> None:
    answer = client.post(
        "/api/hermes/review",
        json={
            "files": ["../../etc/passwd", "hermes--never-proposed.md"],
            "decision": "decline",
            "projectDir": "/work/shop/.workpilot/worktrees/001-cart",
            "specId": "001-cart",
        },
    ).json()

    assert answer["success"] is True
    review = answer["review"]
    assert review["declined"] == [] and review["adopted"] == []
    assert [s["file"] for s in review["skipped"]] == [
        "../../etc/passwd",
        "hermes--never-proposed.md",
    ]
    assert "status" in answer


@pytest.mark.parametrize(
    ("project_dir", "spec_id", "ref"),
    [
        ("/work/shop/.workpilot/worktrees/001-cart", "specs/001-cart", "shop/001-cart"),
        ("C:\\work\\shop", "specs\\003-ship", "shop/003-ship"),
        ("/work/shop", None, None),
        (None, "001-cart", None),
    ],
)
def test_the_task_a_decision_links_to_is_named_from_its_paths(
    project_dir, spec_id, ref
) -> None:
    from hermes.api import _task_ref

    assert _task_ref(project_dir, spec_id) == ref


def test_the_task_name_reads_no_file(monkeypatch: pytest.MonkeyPatch) -> None:
    from hermes.api import _task_ref

    def no_resolve(self, *args, **kwargs):
        raise AssertionError("a client path is a name, never resolved")

    monkeypatch.setattr(Path, "resolve", no_resolve)

    assert _task_ref("/work/shop", "002-pay") == "shop/002-pay"


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/api/hermes/status", None),
        ("POST", "/api/hermes/cycle", {}),
        ("POST", "/api/hermes/review", {"decision": "adopt"}),
        ("POST", "/api/hermes/soul/install", {}),
    ],
)
def test_every_route_refuses_server_mode(
    client, monkeypatch: pytest.MonkeyPatch, method, path, body
) -> None:
    import hermes.api as api

    monkeypatch.setattr(api, "server_mode_roots", lambda: [Path("/srv")])

    answer = client.request(method, path, json=body).json()

    assert answer == {
        "success": False,
        "error": "the hermes learning loop is a desktop feature",
        "reason": "server-mode",
    }


@pytest.mark.parametrize(
    ("method", "path", "body", "broken"),
    [
        ("GET", "/api/hermes/status", None, "_status_payload"),
        ("POST", "/api/hermes/cycle", {}, "run_cycle"),
        ("POST", "/api/hermes/review", {"decision": "adopt"}, "_status_payload"),
        ("POST", "/api/hermes/soul/install", {}, "install_soul"),
    ],
)
def test_a_failure_is_reported_without_its_detail(
    client, monkeypatch: pytest.MonkeyPatch, method, path, body, broken
) -> None:
    import hermes.api as api

    def fail(*_a, **_k):
        raise RuntimeError("/home/someone/.hermes is unreadable")

    monkeypatch.setattr(api, broken, fail)

    answer = client.request(method, path, json=body).json()

    assert answer == {"success": False, "error": "An internal error has occurred."}


def test_an_installed_hermes_with_an_empty_queue_lists_no_candidate(
    client, repo: Path
) -> None:
    home = Path(__import__("os").environ["HERMES_HOME"])
    (home / "skills").mkdir(parents=True)

    answer = client.get("/api/hermes/status").json()

    status = answer["status"]
    assert status["readiness"]["installed"] is True
    assert status["candidates"] == []
    assert json.dumps(status)  # the whole status is JSON the panel can read
