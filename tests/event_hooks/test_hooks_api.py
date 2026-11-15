"""The hooks API as the desktop app's hooks store calls it.

The router runs in a FastAPI app over HTTP (TestClient); the hook service is
the real one, storing its hooks under a temporary WORKPILOT_DATA_DIR.
"""

from __future__ import annotations

import pytest
from event_hooks import api as hooks_api
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.hooks.hook_service import HookService

MANUAL_HOOK = {
    "name": "Say hello",
    "project_id": "p1",
    "triggers": [{"type": "manual"}],
    "actions": [{"type": "log_event", "config": {"message": "hello"}}],
}


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(HookService, "_instance", None)
    app = FastAPI()
    app.include_router(hooks_api.router)
    return TestClient(app)


def _create(client: TestClient, **fields) -> dict:
    answer = client.post("/api/hooks", json={**MANUAL_HOOK, **fields}).json()
    assert answer["success"], answer
    return answer["hook"]


class TestHooks:
    def test_create_read_update_toggle_duplicate_delete(self, client):
        hook = _create(client)
        hook_id = hook["id"]

        assert client.get(f"/api/hooks/{hook_id}").json()["hook"]["name"] == "Say hello"
        renamed = client.put(f"/api/hooks/{hook_id}", json={"name": "Hi"}).json()
        assert renamed["hook"]["name"] == "Hi"
        paused = client.post(f"/api/hooks/{hook_id}/toggle").json()["hook"]
        assert paused["status"] == "paused"
        copy = client.post(f"/api/hooks/{hook_id}/duplicate").json()["hook"]
        assert copy["name"] == "Hi (copy)"
        assert copy["id"] != hook_id

        assert len(client.get("/api/hooks").json()["hooks"]) == 2
        assert client.get("/api/hooks", params={"project_id": "other"}).json() == {
            "success": True,
            "hooks": [],
        }
        removed = client.delete(f"/api/hooks/{hook_id}")
        assert removed.json() == {"success": True}
        assert [h["id"] for h in client.get("/api/hooks").json()["hooks"]] == [
            copy["id"]
        ]

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/api/hooks/nope"),
            ("put", "/api/hooks/nope"),
            ("delete", "/api/hooks/nope"),
            ("post", "/api/hooks/nope/toggle"),
            ("post", "/api/hooks/nope/duplicate"),
        ],
    )
    def test_an_unknown_hook_is_404(self, client, method, path):
        kwargs = {"json": {"name": "x"}} if method == "put" else {}

        answer = getattr(client, method)(path, **kwargs)

        assert answer.status_code == 404
        assert answer.json() == {"detail": hooks_api.HOOK_NOT_FOUND}

    def test_literal_paths_are_not_taken_for_a_hook_id(self, client):
        assert client.get("/api/hooks/stats").json()["success"] is True
        assert client.get("/api/hooks/executions/history").json() == {
            "success": True,
            "executions": [],
        }


class TestTemplatesAndEvents:
    def test_a_template_becomes_a_hook(self, client):
        templates = client.get("/api/hooks/templates").json()["templates"]
        template_id = templates[0]["id"]

        hook = client.post(
            "/api/hooks/from-template",
            json={"template_id": template_id, "project_id": "p1"},
        ).json()["hook"]

        assert hook["project_id"] == "p1"
        missing = client.post("/api/hooks/from-template", json={"template_id": "nope"})
        assert missing.status_code == 404
        assert missing.json() == {"detail": hooks_api.TEMPLATE_NOT_FOUND}

    def test_an_emitted_event_runs_the_matching_hooks(self, client):
        hook = _create(client)

        answer = client.post(
            "/api/hooks/emit", json={"type": "manual", "project_id": "p1", "data": {}}
        ).json()

        assert answer["success"] is True
        assert answer["hooks_triggered"] == 1
        [execution] = answer["executions"]
        assert execution["hook_id"] == hook["id"]
        history = client.get(
            "/api/hooks/executions/history", params={"hook_id": hook["id"], "limit": 5}
        ).json()["executions"]
        assert len(history) == 1
        assert client.get("/api/hooks/stats").json()["stats"]["total_hooks"] == 1

    def test_an_unknown_event_type_is_an_error_without_details(self, client):
        answer = client.post("/api/hooks/emit", json={"type": "teleport"}).json()

        assert answer["success"] is False
        assert "teleport" not in answer["error"]


class TestFailures:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("get", "/api/hooks", None),
            ("get", "/api/hooks/stats", None),
            ("get", "/api/hooks/templates", None),
            ("get", "/api/hooks/executions/history", None),
            ("post", "/api/hooks", {"name": "x"}),
            ("post", "/api/hooks/emit", {"type": "manual"}),
            ("post", "/api/hooks/from-template", {"template_id": "t"}),
            ("get", "/api/hooks/h1", None),
            ("put", "/api/hooks/h1", {"name": "x"}),
            ("delete", "/api/hooks/h1", None),
            ("post", "/api/hooks/h1/toggle", None),
            ("post", "/api/hooks/h1/duplicate", None),
        ],
    )
    def test_a_service_failure_is_reported_without_its_text(
        self, client, monkeypatch, method, path, body
    ):
        def broken():
            raise OSError("/home/secret/path is unreadable")

        monkeypatch.setattr(hooks_api, "_service", broken)
        kwargs = {"json": body} if body is not None else {}

        answer = getattr(client, method)(path, **kwargs)

        assert answer.status_code == 200
        assert answer.json()["success"] is False
        assert "secret" not in answer.json()["error"]
