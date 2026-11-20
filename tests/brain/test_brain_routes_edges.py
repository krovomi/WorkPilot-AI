"""The ``/api/brain`` routes on the paths the feature tests do not take:
server mode, missing arguments, unknown ids, and the folder checks."""

from __future__ import annotations

from pathlib import Path

import pytest
from brain import api as brain_api

ROUTES = [
    ("get", "settings", None),
    ("post", "settings", {}),
    ("get", "task", None),
    ("get", "memories", None),
    ("get", "learning-patterns", None),
    ("post", "learning-patterns/toggle", {}),
    ("post", "learning-patterns/delete", {}),
    ("get", "review-lessons", None),
    ("post", "review-lessons/adopt", {}),
    ("post", "review-lessons/dismiss", {}),
    ("post", "review-lessons/plan-feedback", {}),
    ("post", "instruction", {"path": "x", "status": "active"}),
    ("get", "status", None),
    ("post", "sync", {}),
    ("post", "recall", {"query": "x"}),
    ("post", "learn", {"surface": "x", "title": "t", "body": "b"}),
]


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    for name in ("HOME", "USERPROFILE", "WORKPILOT_BRAIN_HOME"):
        monkeypatch.setenv(name, str(home))
    monkeypatch.setenv("APPDATA", str(home / "AppData"))
    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(home / "brain.json"))
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    return home


@pytest.fixture
def client(home):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(brain_api.router)
    return TestClient(app)


def call(client, method: str, route: str, body: dict | None = None, **params):
    url = f"/api/brain/{route}"
    if method == "get":
        return client.get(url, params=params).json()
    return client.post(url, json=body or {}).json()


@pytest.mark.parametrize(("method", "route", "body"), ROUTES)
def test_server_mode_refuses_every_route(client, monkeypatch, method, route, body):
    monkeypatch.setattr(brain_api, "server_mode_roots", lambda: [Path("/srv")])

    assert call(client, method, route, body) == brain_api._DESKTOP_ONLY


class TestMissingArguments:
    @pytest.mark.parametrize(
        ("method", "route", "body", "params"),
        [
            ("get", "task", None, {"project_dir": "/home/me/shop"}),
            ("get", "memories", None, {}),
            ("get", "learning-patterns", None, {}),
            ("post", "learning-patterns/toggle", {"project_dir": "/x/shop"}, {}),
            ("post", "learning-patterns/delete", {"project_dir": "/x/shop"}, {}),
            ("post", "review-lessons/adopt", {"project_dir": "/nowhere"}, {}),
            ("post", "review-lessons/dismiss", {"lesson_id": "1"}, {}),
            ("post", "review-lessons/plan-feedback", {"project_dir": "/nowhere"}, {}),
        ],
    )
    def test_each_route_says_what_it_needs(self, client, method, route, body, params):
        reply = call(client, method, route, body, **params)

        assert reply["success"] is False and "required" in reply["error"]

    def test_an_instruction_status_outside_the_two(self, client):
        reply = call(client, "post", "instruction", {"path": "x.md", "status": "maybe"})
        assert reply["code"] == "invalid-status"


class TestUnknownIds:
    def test_learning_patterns_that_do_not_exist(self, client, home):
        body = {"project_dir": str(home / "shop"), "pattern_id": "nope"}

        assert call(client, "post", "learning-patterns/toggle", body)["error"] == (
            "Pattern not found"
        )
        assert call(client, "post", "learning-patterns/delete", body)["error"] == (
            "Pattern not found"
        )

    def test_review_lessons_that_do_not_exist(self, client, home):
        project = home / "shop"
        project.mkdir()
        body = {"project_dir": str(project), "lesson_id": "nope", "rule": "x"}

        adopted = call(client, "post", "review-lessons/adopt", body)
        dismissed = call(client, "post", "review-lessons/dismiss", body)

        assert adopted["error"] == "Lesson not found or empty rule"
        assert dismissed["error"] == "Lesson not found"


class TestMemories:
    def test_listing_and_searching_a_project_memory(self, client, home, monkeypatch):
        from brain import project_memory

        seen: list[tuple] = []
        monkeypatch.setattr(
            project_memory,
            "list_memories",
            lambda project, limit: seen.append(("list", project, limit)) or ["m"],
        )
        monkeypatch.setattr(
            project_memory,
            "search_memories",
            lambda project, query, limit: (
                seen.append(("search", query, limit)) or ["r"]
            ),
        )

        listed = call(client, "get", "memories", project_dir="/x/shop", limit=0)
        found = call(
            client, "get", "memories", project_dir="/x/shop", query=" auth ", limit=999
        )

        assert listed == {"success": True, "memories": ["m"]}
        assert found == {"success": True, "results": ["r"]}
        assert seen == [("list", "shop", 20), ("search", " auth ", 200)]


class TestStatusRecallLearn:
    def test_status_and_recall_without_a_brain(self, client):
        status = call(client, "get", "status")
        recall = call(client, "post", "recall", {"query": "deploy"})

        assert status["success"] is True and isinstance(status["memories"], list)
        assert recall["success"] is True

    def test_learn_names_the_surfaces_it_knows(self, client):
        reply = call(
            client, "post", "learn", {"surface": "nope", "title": "t", "body": "b"}
        )

        assert reply["success"] is False and "verify" in reply["surfaces"]

    def test_learn_files_a_note_under_its_surface(self, client, monkeypatch):
        from brain import learn

        monkeypatch.setattr(learn, "record", lambda *a, **k: "knowledge/x.md")

        reply = call(
            client,
            "post",
            "learn",
            {"surface": "verify", "title": "t", "body": "b", "project": "shop"},
        )

        assert reply == {"success": True, "path": "knowledge/x.md"}


class TestFolders:
    def test_a_file_is_not_a_brain_folder(self, home):
        (home / "notes.md").write_text("x", encoding="utf-8")

        assert brain_api._home_path(str(home / "notes.md")) == (None, "is-file")

    def test_the_containment_holds_where_the_path_is_opened(
        self, home, tmp_path, monkeypatch
    ):
        # Even with the placement rules out of the way, a folder outside the
        # home directory is refused at the point it would be opened.
        monkeypatch.setattr(brain_api, "_placement_refusal", lambda *_a: None)

        assert brain_api._home_path(str(tmp_path / "elsewhere")) == (
            None,
            "outside-home",
        )

    def test_a_folder_that_cannot_be_inspected(self, home, monkeypatch):
        def broken(self):
            raise PermissionError("denied")

        monkeypatch.setattr(Path, "is_file", broken)

        assert brain_api._home_path(str(home / "vault")) == (None, "outside-home")

    def test_an_empty_path_resets_the_folder(self, client, home, monkeypatch):
        written: list[dict] = []
        monkeypatch.setattr(
            brain_api, "write_config", lambda **kwargs: written.append(kwargs)
        )

        reply = call(client, "post", "settings", {"path": "  ", "connect": False})

        assert reply["success"] is True and written == [{"path": None}]

    def test_git_without_words_has_no_detail(self):
        assert brain_api._git_detail("") is None and brain_api._git_detail(None) is None


def test_a_broken_settings_view_still_answers(client, monkeypatch):
    def broken(_request):
        raise RuntimeError("bug in a parser")

    def broken_view(*_a, **_k):
        raise RuntimeError("the view too")

    monkeypatch.setattr(brain_api, "_save_settings", broken)
    monkeypatch.setattr(brain_api, "_refusal", broken_view)

    reply = call(client, "post", "settings", {"path": "x"})

    assert reply == {"success": False, "error": "failed", "code": "failed"}
