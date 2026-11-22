"""A linked service rolled back with the one that failed (#366, lot 4)."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from deploy_watch import linked, watch
from deploy_watch.rollback import RollbackPlan
from deploy_watch.watch import RUNS_FILE, WatchError, read_state, state_path

SINCE = "2026-11-15T08:00:00+00:00"
NOW = datetime(2026, 11, 15, 10, 30, tzinfo=UTC)


def _now() -> datetime:
    return NOW


def _project(tmp_path: Path, runs: list) -> Path:
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / RUNS_FILE).write_text(json.dumps(runs), encoding="utf-8")
    return tmp_path


RUNS = [
    # Newest first, as the app records them.
    {"id": "300", "provider": "github", "status": "triggered",
     "triggered_at": "2026-11-15T10:00:00Z"},
    {"id": "200", "provider": "github", "status": "triggered",
     "triggered_at": "2026-11-15T09:00:00Z"},
    {"id": "150", "provider": "github", "status": "failed",
     "triggered_at": "2026-11-15T08:30:00Z"},
    {"id": "../x", "provider": "github", "status": "triggered",
     "triggered_at": "2026-11-15T08:10:00Z"},
    {"id": "100", "provider": "github", "status": "triggered",
     "triggered_at": "2026-11-15T07:00:00Z"},
    {"id": "90", "status": "triggered", "triggered_at": "not a date"},
]  # fmt: skip


@pytest.fixture
def planned(monkeypatch):
    """The plan of the run rolled back, and the runs it was asked for."""
    asked: list[dict] = []
    plan = RollbackPlan(
        "github",
        "rerun",
        automatic=True,
        target_run="99",
        target_sha="a" * 40,
        current_sha="b" * 40,
    )

    def plan_rollback(env, run, fetch):
        asked.append(run)
        return plan

    monkeypatch.setattr(watch, "plan_rollback", plan_rollback)
    monkeypatch.setattr(watch, "changed_paths", lambda *a: ["src/app.py"])
    monkeypatch.setattr(linked, "execute_rollback", lambda *a: True)
    return asked


class TestLinkedRollback:
    def test_goes_back_to_before_the_earliest_run_since(
        self, tmp_path, fake_fetch, planned
    ):
        project = _project(tmp_path, RUNS)
        result = linked.run_linked_rollback(
            project, SINCE, {}, cause="Shop API", fetch=fake_fetch(), now=_now
        )
        assert [run["id"] for run in planned] == ["200"]
        assert (result["status"], result["run_id"], result["migrations"]) == (
            "started",
            "200",
            [],
        )
        state = read_state(project, "200")
        assert state["reason"] == "linked_rollback"
        assert (state["rollback"], state["rollback_by"], state["linked_cause"]) == (
            "started",
            "linked",
            "Shop API",
        )
        assert state["rollback_at"] == NOW.isoformat()
        assert state["phase"] == "done"

    def test_nothing_deployed_since(self, tmp_path, fake_fetch, planned):
        project = _project(tmp_path, RUNS)
        result = linked.run_linked_rollback(
            project, "2026-11-16T00:00:00Z", {}, fetch=fake_fetch()
        )
        assert result == {"status": "not_deployed_since"}
        assert planned == []

    def test_a_bad_time_is_refused(self, tmp_path, fake_fetch):
        project = _project(tmp_path, RUNS)
        with pytest.raises(WatchError):
            linked.run_linked_rollback(project, "yesterday", {}, fetch=fake_fetch())

    def test_the_cause_is_bounded(self, tmp_path, fake_fetch, planned):
        project = _project(tmp_path, RUNS)
        linked.run_linked_rollback(
            project, SINCE, {}, cause="x" * 500, fetch=fake_fetch(), now=_now
        )
        assert len(read_state(project, "200")["linked_cause"]) == linked.MAX_CAUSE

    def test_migrations_block_it(self, tmp_path, fake_fetch, planned, monkeypatch):
        monkeypatch.setattr(
            watch, "changed_paths", lambda *a: ["db/migrate/20261115_add.rb"]
        )
        monkeypatch.setattr(
            linked, "execute_rollback", lambda *a: pytest.fail("must not roll back")
        )
        project = _project(tmp_path, RUNS)
        result = linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch())
        assert result["status"] == "blocked_migrations"
        assert "rollback_at" not in read_state(project, "200")

    def test_manual_and_failed(self, tmp_path, fake_fetch, planned, monkeypatch):
        project = _project(tmp_path, RUNS)
        monkeypatch.setattr(linked, "execute_rollback", lambda *a: False)
        failed = linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch())
        assert failed["status"] == "failed"
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: RollbackPlan("gitlab", "manual")
        )
        manual = linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch())
        assert manual["status"] == "manual"

    def test_strict_offline_stays_manual(self, tmp_path, fake_fetch, monkeypatch):
        project = _project(tmp_path, RUNS)
        monkeypatch.setattr(linked, "_offline", lambda *_: True)
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: pytest.fail("no provider offline")
        )
        result = linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch())
        assert (result["status"], result["plan"]["reason"]) == ("manual", "offline")

    def test_keeps_the_watch_state_it_finds(self, tmp_path, fake_fetch, planned):
        project = _project(tmp_path, RUNS)
        path = state_path(project, "200")
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"run_id": "200", "phase": "done", "verdict": "ok"}),
            encoding="utf-8",
        )
        linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch(), now=_now)
        state = read_state(project, "200")
        assert (state["verdict"], state["rollback"]) == ("ok", "started")
        assert "reason" not in state

    def test_leaves_a_running_watch_alone(self, tmp_path, fake_fetch, planned):
        project = _project(tmp_path, RUNS)
        path = state_path(project, "200")
        path.parent.mkdir(parents=True)
        running = {"run_id": "200", "phase": "watching"}
        path.write_text(json.dumps(running), encoding="utf-8")
        result = linked.run_linked_rollback(project, SINCE, {}, fetch=fake_fetch())
        assert result["status"] == "started"
        assert read_state(project, "200") == running


RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "deploy_watch_runner.py"
)


def test_runner_action(tmp_path, capsys, monkeypatch):
    sys.path.insert(0, str(RUNNER.parent))
    try:
        import deploy_watch_runner
    finally:
        sys.path.remove(str(RUNNER.parent))
    seen = []

    def fake(project, since, env, *, cause):
        seen.append((since, cause))
        return {"status": "not_deployed_since"}

    monkeypatch.setattr(linked, "run_linked_rollback", fake)
    project = _project(tmp_path, RUNS)
    args = ["--action", "rollback-linked", "--project", str(project)]
    assert deploy_watch_runner.main([*args, "--since", SINCE, "--cause", "API"]) == 0
    assert json.loads(capsys.readouterr().out) == {"status": "not_deployed_since"}
    assert seen == [(SINCE, "API")]
    monkeypatch.undo()
    assert deploy_watch_runner.main([*args, "--since", "nope"]) == 1
    assert "invalid time" in capsys.readouterr().err
