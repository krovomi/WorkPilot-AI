"""Session History: the replay store as the panel reads it, over HTTP.

The sessions come from a real recorder writing into a temporary store; only
the store's location is moved away from the home directory.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from dashboard.api import _epoch_to_iso, _replay_summary_to_session_entry, router
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def recorder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import replay.recorder as module

    store = module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(module, "_replay_recorder", store)
    return store


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    import dashboard.api as api

    monkeypatch.setattr(api, "server_mode_roots", lambda: None)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_recorded_sessions_are_listed_in_the_panels_shape(client, recorder) -> None:
    recorder.start_session(
        "s-done",
        {"agent_name": "Coder", "task": "Add a cart", "project_path": "/work/shop"},
    )
    recorder.end_session("s-done")
    recorder.start_session("s-failed", {"agent_name": "QA"})
    recorder.end_session("s-failed", status="failed")

    answer = client.get("/api/sessions/project-001").json()

    assert answer["success"] is True
    entries = {s["session_id"]: s for s in answer["sessions"]}
    done = entries["s-done"]
    assert done["task_title"] == "Add a cart"
    assert done["status"] == "completed"
    assert done["project_path"] == "/work/shop"
    assert done["started_at"].endswith("+00:00") and done["ended_at"]
    assert isinstance(done["duration_seconds"], int)
    assert entries["s-failed"]["task_title"] == "QA"
    assert entries["s-failed"]["status"] == "failed"


def test_a_session_still_recording_shows_as_running() -> None:
    entry = _replay_summary_to_session_entry(
        {"session_id": "s-live", "status": "recording", "start_time": 0}
    )

    assert entry["status"] == "running"
    assert entry["task_title"] == "s-live"
    assert entry["started_at"] == "1970-01-01T00:00:00+00:00"
    assert entry["ended_at"] is None and entry["duration_seconds"] is None


def test_a_summary_without_status_reads_as_completed() -> None:
    assert _replay_summary_to_session_entry({})["status"] == "completed"


@pytest.mark.parametrize("ts", [None, "soon", float("inf"), 10**20])
def test_a_time_that_is_not_one_gives_no_date(ts) -> None:
    assert _epoch_to_iso(ts) is None


def test_an_unreadable_store_is_reported_without_its_detail(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    import replay.recorder as module

    class Broken:
        def list_sessions(self):
            raise PermissionError("/home/someone/.workpilot/replays")

    monkeypatch.setattr(module, "_replay_recorder", Broken())

    answer = client.get("/api/sessions/project-001").json()

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]


def test_the_history_is_not_served_by_a_server(monkeypatch: pytest.MonkeyPatch) -> None:
    import dashboard.api as api

    monkeypatch.setattr(api, "server_mode_roots", lambda: [Path("/srv/projects")])
    app = FastAPI()
    app.include_router(router)

    assert TestClient(app).get("/api/sessions/project-001").status_code == 404


def test_the_dashboard_routes_nothing_called_are_gone() -> None:
    paths = {route.path for route in router.routes}

    assert paths == {"/api/sessions/{project_id}"}
