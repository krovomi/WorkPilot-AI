"""The Agent Health panel's routes, on a monitor of their own."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    import agent_health.api as api

    monkeypatch.setattr(api, "_monitor", None)
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _run(name: str, success: bool = True, **extra) -> dict:
    return {"agent_name": name, "success": success, "duration_s": 2.0, **extra}


def test_an_agent_is_scored_once_it_has_three_runs(client) -> None:
    assert client.post("/api/agent-health/record", json=_run("coder")).json() == {
        "success": True
    }
    early = client.get("/api/agent-health/score/coder").json()
    assert early["success"] is True and early["score"] is None
    assert "3" in early["reason"]

    batch = client.post(
        "/api/agent-health/record-batch",
        json={"runs": [_run("coder"), _run("coder", False, error="boom", retries=2)]},
    ).json()
    assert batch == {"success": True, "recorded": 2}

    score = client.get("/api/agent-health/score/coder").json()["score"]
    assert score["agent_name"] == "coder"
    assert score["runs_in_window"] == 3
    assert score["success_rate"] == pytest.approx(0.667, abs=0.001)


def test_every_known_agent_is_listed_and_a_reset_forgets_one(client) -> None:
    client.post(
        "/api/agent-health/record-batch",
        json={"runs": [_run("coder")] * 3 + [_run("planner")] * 3},
    )

    listed = client.get("/api/agent-health/scores").json()
    assert sorted(listed["agents_known"]) == ["coder", "planner"]
    assert {s["agent_name"] for s in listed["scores"]} == {"coder", "planner"}

    assert client.post("/api/agent-health/reset", json={"agent_name": "coder"}).json()[
        "success"
    ]
    assert client.get("/api/agent-health/scores").json()["agents_known"] == ["planner"]

    client.post("/api/agent-health/reset", json={})
    assert client.get("/api/agent-health/scores").json()["agents_known"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"agent_name": ""},
        {"agent_name": "coder", "duration_s": -1},
        {"agent_name": "coder", "retries": -1},
        {"agent_name": "x" * 129},
    ],
)
def test_a_run_outside_its_bounds_is_refused_before_it_is_recorded(
    client, body
) -> None:
    assert client.post("/api/agent-health/record", json=body).status_code == 422
    assert client.get("/api/agent-health/scores").json()["agents_known"] == []


@pytest.mark.parametrize(
    ("method", "path", "body", "broken"),
    [
        ("POST", "/api/agent-health/record", _run("coder"), "record"),
        (
            "POST",
            "/api/agent-health/record-batch",
            {"runs": [_run("coder")]},
            "record_many",
        ),
        ("GET", "/api/agent-health/score/coder", None, "score"),
        ("GET", "/api/agent-health/scores", None, "score_all"),
        ("POST", "/api/agent-health/reset", {}, "reset"),
    ],
)
def test_a_failing_monitor_is_reported_without_its_detail(
    client, monkeypatch: pytest.MonkeyPatch, method, path, body, broken
) -> None:
    from agent_health.monitor import HealthMonitor

    def fail(*_a, **_k):
        raise RuntimeError("/home/someone/.workpilot is unreadable")

    monkeypatch.setattr(HealthMonitor, broken, fail)

    answer = client.request(method, path, json=body).json()

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]


def test_an_unreadable_project_is_reported_without_its_detail(
    client, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    import agent_health.api as api

    def unreadable(_project):
        raise PermissionError("/home/someone/project/.workpilot")

    monkeypatch.setattr(api, "project_health", unreadable)

    answer = client.post(
        "/api/agent-health/project", json={"project_path": str(tmp_path)}
    ).json()

    assert answer["success"] is False
    assert "/home/someone" not in answer["error"]
