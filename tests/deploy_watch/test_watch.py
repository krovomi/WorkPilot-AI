"""The observation window, end to end with a fake clock and network (#366)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from deploy_watch import watch
from deploy_watch.config import CONFIG_FILE
from deploy_watch.rollback import RollbackPlan
from deploy_watch.watch import (
    RUNS_FILE,
    WatchError,
    find_run,
    read_state,
    run_rollback,
    run_watch,
    state_path,
)

HEALTH = "https://app.example/health"
PROM = "https://prom.example"
RUN_ID = "1763200000000"


def _project(
    tmp_path: Path, runs: object | None = None, monitors: str | None = None
) -> Path:
    (tmp_path / ".workpilot").mkdir()
    default = [
        {"id": RUN_ID, "provider": "github", "triggered_at": "2026-11-15T10:00:00Z"}
    ]
    (tmp_path / RUNS_FILE).write_text(
        json.dumps(default if runs is None else runs), encoding="utf-8"
    )
    if monitors is not None:
        (tmp_path / CONFIG_FILE).write_text(monitors, encoding="utf-8")
    return tmp_path


class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
        self.slept: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += timedelta(seconds=seconds)

    def __call__(self) -> datetime:
        return self.now


def _vector(value: float) -> dict:
    return {"data": {"resultType": "vector", "result": [{"value": [0, str(value)]}]}}


MONITORS = """
window_minutes: 3
deploy_wait_minutes: 1
stabilization_seconds: 0
interval_seconds: 60
metrics:
  - {name: errors, kind: error_rate, query: errors}
"""


def _env(**extra) -> dict:
    return {
        "CICD_MONITOR_HEALTH_URL": HEALTH,
        "CICD_MONITOR_PROMETHEUS_URL": PROM,
        **extra,
    }


class TestRuns:
    def test_find_run(self, tmp_path):
        project = _project(
            tmp_path, [7, {"id": "2"}, {"id": RUN_ID, "provider": "github"}]
        )
        assert find_run(project, RUN_ID)["provider"] == "github"
        with pytest.raises(WatchError):
            find_run(project, "../x")
        with pytest.raises(WatchError):
            find_run(project, "3")

    def test_bad_runs_file(self, tmp_path):
        project = _project(tmp_path, {"not": "a list"})
        with pytest.raises(WatchError):
            find_run(project, RUN_ID)
        (project / RUNS_FILE).write_text("{oops", encoding="utf-8")
        with pytest.raises(WatchError):
            find_run(project, RUN_ID)
        (project / RUNS_FILE).unlink()
        with pytest.raises(WatchError):
            find_run(project, RUN_ID)

    def test_state_paths(self, tmp_path):
        with pytest.raises(WatchError):
            state_path(tmp_path, "a/b")
        assert read_state(tmp_path, RUN_ID) is None
        path = state_path(tmp_path, RUN_ID)
        path.parent.mkdir(parents=True)
        path.write_text("[1]", encoding="utf-8")
        assert read_state(tmp_path, RUN_ID) is None
        path.write_text("{bad", encoding="utf-8")
        assert read_state(tmp_path, RUN_ID) is None


class TestRunWatch:
    def test_not_configured(self, tmp_path, fake_fetch):
        project = _project(tmp_path)
        state = run_watch(
            project, RUN_ID, {}, fetch=fake_fetch(), sleep=Clock().sleep, now=Clock()
        )
        assert (state["phase"], state["reason"], state["verdict"]) == (
            "done",
            "not_configured",
            "unknown",
        )
        assert read_state(project, RUN_ID)["phase"] == "done"

    def test_healthy_deployment(self, tmp_path, fake_fetch):
        project = _project(tmp_path, monitors=MONITORS)
        clock = Clock()
        fetch = fake_fetch({HEALTH: (200, b"ok"), PROM: (200, _vector(0.01))})
        state = run_watch(
            project, RUN_ID, _env(), fetch=fetch, sleep=clock.sleep, now=clock
        )
        assert state["verdict"] == "ok"
        assert state["baseline"] == {"errors": 0.01}
        assert len(state["samples"]) == 3
        assert clock.slept == [60, 60, 60]
        assert "plan" not in state
        assert state["ends_at"] == "2026-11-15T10:04:00+00:00"

    def test_critical_ends_early_and_proposes_a_rollback(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        project = _project(
            tmp_path,
            monitors=MONITORS.replace("window_minutes: 3", "window_minutes: 10"),
        )
        values = iter([0.01, 0.05, 0.05, 0.05])
        fetch = fake_fetch(
            {
                HEALTH: (200, b""),
                PROM: lambda _r: (200, json.dumps(_vector(next(values))).encode()),
            }
        )
        plan = RollbackPlan(
            "github",
            "rerun",
            automatic=True,
            target_run="10",
            target_sha="a" * 40,
            current_sha="b" * 40,
        )
        monkeypatch.setattr(watch, "plan_rollback", lambda env, run, fetch: plan)
        monkeypatch.setattr(watch, "changed_paths", lambda *a: ["src/app.py"])
        clock = Clock()
        state = run_watch(
            project, RUN_ID, _env(), fetch=fetch, sleep=clock.sleep, now=clock
        )
        assert state["verdict"] == "critical"
        assert len(state["samples"]) == 2
        assert (state["rollback"], state["migrations"]) == ("proposed", [])
        assert state["plan"]["target_run"] == "10"

    def test_auto_rollback(self, tmp_path, fake_fetch, monkeypatch):
        project = _project(tmp_path, monitors=MONITORS)
        fetch = fake_fetch({HEALTH: (503, b"")})
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        monkeypatch.setattr(watch, "plan_rollback", lambda env, run, fetch: plan)
        started = []
        monkeypatch.setattr(
            watch,
            "execute_rollback",
            lambda env, run, p, fetch: started.append(p) or True,
        )
        clock = Clock()
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_AUTO_ROLLBACK="true", CICD_MONITOR_PROMETHEUS_URL=""),
            fetch=fetch,
            sleep=clock.sleep,
            now=clock,
        )
        assert state["rollback"] == "started"
        assert state["migrations"] is None
        assert started == [plan]

        monkeypatch.setattr(watch, "execute_rollback", lambda *a: False)
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_AUTO_ROLLBACK="true", CICD_MONITOR_PROMETHEUS_URL=""),
            fetch=fetch,
            sleep=clock.sleep,
            now=clock,
        )
        assert state["rollback"] == "failed"

    def test_a_migration_blocks_the_automatic_rollback(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        project = _project(tmp_path, monitors=MONITORS)
        plan = RollbackPlan(
            "azure",
            "redeploy_commit",
            automatic=True,
            target_sha="a" * 40,
            current_sha="b" * 40,
        )
        monkeypatch.setattr(watch, "plan_rollback", lambda env, run, fetch: plan)
        monkeypatch.setattr(
            watch, "changed_paths", lambda *a: ["db/migrate/20261115_add.rb", "app.rb"]
        )
        monkeypatch.setattr(
            watch, "execute_rollback", lambda *a: pytest.fail("must not roll back")
        )
        clock = Clock()
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_AUTO_ROLLBACK="true", CICD_MONITOR_PROMETHEUS_URL=""),
            fetch=fake_fetch({HEALTH: (500, b"")}),
            sleep=clock.sleep,
            now=clock,
        )
        assert (state["rollback"], state["migrations"]) == (
            "blocked_migrations",
            ["db/migrate/20261115_add.rb"],
        )

    def test_manual_provider(self, tmp_path, fake_fetch, monkeypatch):
        project = _project(tmp_path, monitors=MONITORS)
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: RollbackPlan("gitlab", "manual")
        )
        clock = Clock()
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_MONITOR_PROMETHEUS_URL=""),
            fetch=fake_fetch({HEALTH: (500, b"")}),
            sleep=clock.sleep,
            now=clock,
        )
        assert state["rollback"] == "manual"

    def test_strict_offline_reads_only_local_endpoints(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        project = _project(tmp_path, monitors=MONITORS)
        (project / ".workpilot" / "offline-mode.json").write_text(
            '{"airgapStrict": true}', encoding="utf-8"
        )
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: pytest.fail("no provider call offline")
        )
        local = "http://127.0.0.1:9090"
        fetch = fake_fetch({local: (200, _vector(0.0)), HEALTH: (500, b"")})
        clock = Clock()
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_MONITOR_PROMETHEUS_URL=local),
            fetch=fetch,
            sleep=clock.sleep,
            now=clock,
        )
        assert all(not url.startswith(HEALTH) for url in fetch.urls())
        assert "offline: health check skipped" in state["problems"]
        assert state["verdict"] == "ok"

        # Prometheus elsewhere, health check local: the remote one is skipped.
        fetch = fake_fetch({"http://localhost:8080/health": (500, b"")})
        state = run_watch(
            project,
            RUN_ID,
            _env(CICD_MONITOR_HEALTH_URL="http://localhost:8080/health"),
            fetch=fetch,
            sleep=clock.sleep,
            now=clock,
        )
        assert "offline: Prometheus skipped" in state["problems"]
        assert (state["verdict"], state["plan"]["reason"], state["rollback"]) == (
            "critical",
            "offline",
            "manual",
        )

    def test_unreadable_policy_counts_as_strict(self, tmp_path, fake_fetch):
        project = _project(tmp_path, monitors=MONITORS)
        (project / ".workpilot" / "offline-mode.json").write_text(
            "{broken", encoding="utf-8"
        )
        clock = Clock()
        state = run_watch(
            project, RUN_ID, _env(), fetch=fake_fetch(), sleep=clock.sleep, now=clock
        )
        assert state["reason"] == "not_configured"


class TestRunRollback:
    def test_needs_a_watched_run(self, tmp_path, fake_fetch):
        project = _project(tmp_path)
        with pytest.raises(WatchError):
            run_rollback(project, RUN_ID, {}, fetch=fake_fetch())

    def test_person_starts_it(self, tmp_path, fake_fetch, monkeypatch):
        project = _project(tmp_path)
        path = state_path(project, RUN_ID)
        path.parent.mkdir(parents=True)
        path.write_text(
            json.dumps({"run_id": RUN_ID, "verdict": "warning"}), encoding="utf-8"
        )
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        monkeypatch.setattr(watch, "plan_rollback", lambda *a: plan)
        monkeypatch.setattr(watch, "execute_rollback", lambda *a: True)
        state = run_rollback(project, RUN_ID, {}, fetch=fake_fetch(), now=Clock())
        assert (state["rollback"], state["rollback_by"]) == ("started", "person")
        monkeypatch.setattr(watch, "execute_rollback", lambda *a: False)
        assert (
            run_rollback(project, RUN_ID, {}, fetch=fake_fetch())["rollback"]
            == "failed"
        )
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: RollbackPlan("jenkins", "manual")
        )
        assert (
            run_rollback(project, RUN_ID, {}, fetch=fake_fetch())["rollback"]
            == "manual"
        )


RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "deploy_watch_runner.py"
)


class TestRunner:
    def test_main(self, tmp_path, capsys):
        sys.path.insert(0, str(RUNNER.parent))
        try:
            import deploy_watch_runner
        finally:
            sys.path.remove(str(RUNNER.parent))
        project = _project(tmp_path)
        assert (
            deploy_watch_runner.main(
                ["--action", "watch", "--project", str(project), "--run-id", RUN_ID]
            )
            == 0
        )
        assert json.loads(capsys.readouterr().out)["reason"] == "not_configured"
        assert (
            deploy_watch_runner.main(
                ["--action", "rollback", "--project", str(project), "--run-id", "9"]
            )
            == 1
        )
        assert "unknown run" in capsys.readouterr().err
        missing = str(tmp_path / "nope")
        assert (
            deploy_watch_runner.main(
                ["--action", "watch", "--project", missing, "--run-id", RUN_ID]
            )
            == 1
        )

    def test_rollback_action(self, tmp_path, capsys, monkeypatch):
        sys.path.insert(0, str(RUNNER.parent))
        try:
            import deploy_watch_runner
        finally:
            sys.path.remove(str(RUNNER.parent))
        monkeypatch.setattr(
            watch, "run_rollback", lambda project, run_id, env: {"rollback": "manual"}
        )
        project = _project(tmp_path)
        assert (
            deploy_watch_runner.main(
                ["--action", "rollback", "--project", str(project), "--run-id", RUN_ID]
            )
            == 0
        )
        assert json.loads(capsys.readouterr().out) == {"rollback": "manual"}

    def test_as_a_script(self, tmp_path):
        project = _project(tmp_path)
        env = {k: v for k, v in os.environ.items() if not k.startswith("CICD_")}
        env.pop("PYTHONPATH", None)
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--action",
                "watch",
                "--project",
                str(project),
                "--run-id",
                RUN_ID,
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["phase"] == "done"
