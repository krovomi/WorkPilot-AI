"""Agent health read from the project's own Kanban tasks (``task_logs.json``)."""

from __future__ import annotations

import json
from pathlib import Path

from agent_health.task_history import phase_runs, project_health, task_log_files
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _phase(status, started, completed, entries=()):
    return {
        "phase": "x",
        "status": status,
        "started_at": started,
        "completed_at": completed,
        "entries": list(entries),
    }


def _entry(kind, provider="openai", model="gpt-6.1-sol", content=""):
    return {"type": kind, "provider": provider, "model": model, "content": content}


def _logs(updated="2026-11-10T10:00:00+00:00", **phases):
    return {"spec_id": "s", "updated_at": updated, "phases": phases}


def _write(dir_: Path, data: dict) -> Path:
    dir_.mkdir(parents=True, exist_ok=True)
    path = dir_ / "task_logs.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_finished_phases_become_runs_with_their_model_duration_and_restarts():
    data = _logs(
        planning=_phase(
            "completed",
            "2026-11-10T10:00:00+00:00",
            "2026-11-10T10:02:00+00:00",
            [
                _entry("phase_start", "ollama", "qwen3-coder"),
                _entry("text", "ollama", "qwen3-coder"),
            ],
        ),
        coding=_phase(
            "failed",
            "2026-11-10T10:03:00+00:00",
            "2026-11-10T10:13:00+00:00",
            [
                _entry("phase_start"),
                _entry("error", content="dotnet build failed"),
                _entry("phase_start"),
                _entry("error", content="x" * 500),
            ],
        ),
        validation=_phase("active", "2026-11-10T10:14:00+00:00", None),
    )
    runs = phase_runs(data)
    assert [r.key.role for r in runs] == ["planner", "coder"]  # active QA is not a run
    planner, coder = runs
    assert (planner.key.provider, planner.key.model) == ("ollama", "qwen3-coder")
    assert (
        planner.run.success
        and planner.run.duration_s == 120
        and planner.run.retries == 0
    )
    assert not coder.run.success
    assert coder.run.duration_s == 600
    assert coder.run.retries == 1
    assert len(coder.run.error) == 200


def test_a_task_running_in_its_worktree_is_counted_once_from_its_latest_copy(tmp_path):
    wp = tmp_path / ".workpilot"
    _write(wp / "specs" / "001-a", _logs("2026-11-10T09:00:00+00:00"))
    _write(
        wp / "worktrees" / "tasks" / "001-a" / ".workpilot" / "specs" / "001-a",
        _logs("2026-11-10T11:00:00+00:00"),
    )
    _write(wp / "specs" / "002-b", _logs())
    (wp / "specs" / "003-broken").mkdir(parents=True)
    (wp / "specs" / "003-broken" / "task_logs.json").write_text("{", encoding="utf-8")
    files = task_log_files(tmp_path)
    assert len(files) == 2
    assert any("worktrees" in str(f) for f in files)


def test_project_health_scores_each_role_and_model_and_lists_those_without_enough_runs(
    tmp_path,
):
    specs = tmp_path / ".workpilot" / "specs"
    for i in range(3):
        _write(
            specs / f"00{i}-task",
            _logs(
                coding=_phase(
                    "completed" if i else "failed",
                    f"2026-11-1{i}T10:00:00+00:00",
                    f"2026-11-1{i}T10:05:00+00:00",
                    [_entry("phase_start", "anthropic", "claude-sonnet-5-5")],
                ),
                planning=_phase(
                    "completed",
                    f"2026-11-1{i}T09:00:00+00:00",
                    f"2026-11-1{i}T09:01:00+00:00",
                    [_entry("phase_start", "copilot", "gpt-6.1-sol")] if i == 0 else [],
                ),
            ),
        )
    health = project_health(tmp_path).to_dict()
    assert health["tasks_read"] == 3
    assert health["min_runs"] == 3
    [coder] = health["scores"]
    assert (coder["role"], coder["provider"], coder["model"]) == (
        "coder",
        "anthropic",
        "claude-sonnet-5-5",
    )
    assert coder["runs_in_window"] == 3
    assert round(coder["success_rate"], 2) == 0.67
    pending = {(p["provider"], p["runs"]) for p in health["pending"]}
    assert pending == {("copilot", 1), ("", 2)}


def test_a_project_without_tasks_has_no_scores(tmp_path):
    health = project_health(tmp_path).to_dict()
    assert (
        health["scores"] == [] and health["pending"] == [] and health["tasks_read"] == 0
    )


def test_route_reads_the_project_and_refuses_a_bad_path(tmp_path):
    from agent_health.api import router

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    ok = client.post("/api/agent-health/project", json={"project_path": str(tmp_path)})
    assert ok.status_code == 200 and ok.json()["success"] is True
    bad = client.post(
        "/api/agent-health/project", json={"project_path": str(tmp_path / ".." / "x")}
    )
    assert bad.status_code == 400
