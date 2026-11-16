"""The observation window after a deployment, and what follows it (#366).

`run_watch` reads the run WorkPilot recorded in `.workpilot/cicd_runs.json`
(the runner gets a run id, never a URL), measures the baseline, waits for the
deployment to land and settle, then samples the window. Its state is written
after each step to `.workpilot/deploy_watches/<run id>.json`, which the app
shows. A critical verdict ends the window early and plans the rollback.

Under a strict offline policy only endpoints on the machine or a private
address are read, and no provider API is called: the rollback stays manual.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from foundation.file_utils import write_json_atomic
from offline_policy import airgap_status

from .collectors import Fetch, default_fetch, health_check, prometheus_value
from .config import WatchSettings, is_local_host, load_settings
from .evaluate import HealthResult, Level, compare, sample_level, verdict
from .migrations import changed_paths, migration_files
from .rollback import RollbackPlan, execute_rollback, plan_rollback

RUNS_FILE = Path(".workpilot") / "cicd_runs.json"
WATCH_DIR = Path(".workpilot") / "deploy_watches"
RUN_ID = re.compile(r"^[0-9]{1,20}$")
MAX_RUNS_BYTES = 4 * 1024 * 1024


class WatchError(ValueError):
    """The watch cannot start: unknown run, bad id."""


def _now() -> datetime:
    return datetime.now(UTC)


def find_run(project_dir: Path, run_id: str) -> dict:
    if not RUN_ID.match(run_id):
        raise WatchError("invalid run id")
    path = Path(project_dir) / RUNS_FILE
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RUNS_BYTES:
        raise WatchError("unknown run")
    try:
        runs = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise WatchError("unknown run") from error
    for run in runs if isinstance(runs, list) else []:
        if isinstance(run, dict) and run.get("id") == run_id:
            return run
    raise WatchError("unknown run")


def state_path(project_dir: Path, run_id: str) -> Path:
    if not RUN_ID.match(run_id):
        raise WatchError("invalid run id")
    return Path(project_dir) / WATCH_DIR / f"{run_id}.json"


def read_state(project_dir: Path, run_id: str) -> dict | None:
    path = state_path(project_dir, run_id)
    if path.is_symlink() or not path.is_file():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return state if isinstance(state, dict) else None


def _save(project_dir: Path, state: dict, now: datetime) -> None:
    path = state_path(project_dir, state["run_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = now.isoformat()
    write_json_atomic(path, state)


def _offline(project_dir: Path) -> bool:
    try:
        return bool(airgap_status(project_dir)["airgapStrict"])
    except (ValueError, OSError):
        # A policy file that cannot be read counts as strict: fail closed.
        return True


def _confine(
    settings: WatchSettings, offline: bool, problems: list[str]
) -> WatchSettings:
    if not offline:
        return settings
    health, prometheus = settings.health_url, settings.prometheus_url
    if health and not is_local_host(health):
        problems.append("offline: health check skipped")
        health = ""
    if prometheus and not is_local_host(prometheus):
        problems.append("offline: Prometheus skipped")
        prometheus = ""
    return replace(settings, health_url=health, prometheus_url=prometheus)


def _measure(settings: WatchSettings, fetch: Fetch) -> dict[str, float | None]:
    if not settings.prometheus_url:
        return {}
    return {
        rule.name: prometheus_value(
            settings.prometheus_url, settings.prometheus_token, rule.query, fetch
        )
        for rule in settings.metrics
    }


def _sample(
    settings: WatchSettings,
    baseline: dict[str, float | None],
    fetch: Fetch,
    now: datetime,
) -> dict:
    values = _measure(settings, fetch)
    checks = [
        compare(rule, baseline.get(rule.name), values.get(rule.name))
        for rule in settings.metrics
        if settings.prometheus_url
    ]
    health: HealthResult | None = (
        health_check(settings.health_url, fetch) if settings.health_url else None
    )
    return {
        "at": now.isoformat(),
        "level": sample_level(checks, health).value,
        "health": health.to_dict() if health else None,
        "metrics": [c.to_dict() for c in checks],
    }


def _migrations(project_dir: Path, plan: RollbackPlan) -> list[str] | None:
    if not (plan.target_sha and plan.current_sha):
        return None
    paths = changed_paths(project_dir, plan.target_sha, plan.current_sha)
    return None if paths is None else migration_files(paths)


def _plan(
    project_dir: Path, env: dict, run: dict, offline: bool, fetch: Fetch
) -> RollbackPlan:
    provider = str(run.get("provider") or "")
    if offline:
        return RollbackPlan(provider, "offline")
    return plan_rollback(env, run, fetch)


def run_watch(
    project_dir: Path,
    run_id: str,
    env: dict,
    *,
    fetch: Fetch = default_fetch,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = _now,
) -> dict:
    project_dir = Path(project_dir)
    run = find_run(project_dir, run_id)
    problems: list[str] = []
    offline = _offline(project_dir)
    loaded = load_settings(project_dir, env)
    problems.extend(loaded.problems)
    settings = _confine(loaded, offline, problems)
    started = now()
    state: dict = {
        "run_id": run_id,
        "provider": run.get("provider", ""),
        "started_at": started.isoformat(),
        "phase": "baseline",
        "window_minutes": settings.window_minutes,
        "ends_at": (
            started
            + timedelta(
                minutes=settings.deploy_wait_minutes + settings.window_minutes,
                seconds=settings.stabilization_seconds,
            )
        ).isoformat(),
        "auto_rollback": settings.auto_rollback,
        "problems": problems,
        "samples": [],
        "verdict": Level.UNKNOWN.value,
    }
    if not settings.configured:
        state.update(phase="done", reason="not_configured")
        _save(project_dir, state, now())
        return state

    baseline = _measure(settings, fetch)
    state["baseline"] = baseline
    state["phase"] = "waiting"
    _save(project_dir, state, now())
    sleep(settings.deploy_wait_minutes * 60 + settings.stabilization_seconds)

    state["phase"] = "watching"
    levels: list[Level] = []
    samples = max(1, settings.window_minutes * 60 // settings.interval_seconds)
    for index in range(samples):
        if index:
            sleep(settings.interval_seconds)
        sample = _sample(settings, baseline, fetch, now())
        state["samples"].append(sample)
        levels.append(Level(sample["level"]))
        state["verdict"] = verdict(levels).value
        _save(project_dir, state, now())
        if state["verdict"] == Level.CRITICAL.value:
            break

    state["phase"] = "done"
    if state["verdict"] == Level.CRITICAL.value:
        plan = _plan(project_dir, env, run, offline, fetch)
        migrations = _migrations(project_dir, plan)
        state["plan"] = plan.to_dict()
        state["migrations"] = migrations
        if not plan.automatic:
            state["rollback"] = "manual"
        elif migrations:
            state["rollback"] = "blocked_migrations"
        elif settings.auto_rollback:
            started_ok = execute_rollback(env, run, plan, fetch)
            state["rollback"] = "started" if started_ok else "failed"
        else:
            state["rollback"] = "proposed"
    _save(project_dir, state, now())
    return state


def run_rollback(
    project_dir: Path,
    run_id: str,
    env: dict,
    *,
    fetch: Fetch = default_fetch,
    now: Callable[[], datetime] = _now,
) -> dict:
    """The rollback a person asked for, from the app, on a watched run."""
    project_dir = Path(project_dir)
    run = find_run(project_dir, run_id)
    state = read_state(project_dir, run_id)
    if state is None:
        raise WatchError("run not watched")
    plan = _plan(project_dir, env, run, _offline(project_dir), fetch)
    state["plan"] = plan.to_dict()
    state["migrations"] = _migrations(project_dir, plan)
    if not plan.automatic:
        state["rollback"] = "manual"
    else:
        state["rollback"] = (
            "started" if execute_rollback(env, run, plan, fetch) else "failed"
        )
    state["rollback_by"] = "person"
    _save(project_dir, state, now())
    return state
