"""The observation window after a deployment, and what follows it (#366).

`run_watch` reads the run WorkPilot recorded in `.workpilot/cicd_runs.json`
(the runner gets a run id, never a URL), measures the baseline, waits for the
deployment to land and settle, then samples the window. Its state is written
after each step to `.workpilot/deploy_watches/<run id>.json`, which the app
shows. A critical verdict ends the window early and plans the rollback.

A warning or critical verdict then gets its incident report (`incident`):
the numbers, and a few sentences by the project's model unless the YAML file
says `explain_incident: false`. A critical one opens the revert PR of the
deployed commit when the file says `revert_pr: true` (`revert`). Last, the
alert channels of the CI/CD settings (Slack, PagerDuty, e-mail) get the facts
(`alerts`).

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

from .alerts import SmtpFactory, send_alerts
from .collectors import Fetch, default_fetch, health_check
from .config import WatchSettings, load_settings
from .evaluate import Level, MetricCheck, compare, sample_level, verdict
from .flags import RollbackFlag, flag_from_env, turn_off
from .incident import Ask, explain, markdown, summarize
from .migrations import changed_paths, migration_files
from .net import HealthResult, is_local_host
from .revert import OpenRevertPR, open_revert
from .rollback import RollbackPlan, execute_rollback, plan_rollback

RUNS_FILE = Path(".workpilot") / "cicd_runs.json"
WATCH_DIR = Path(".workpilot") / "deploy_watches"
RUN_ID = re.compile(r"^[0-9]{1,20}$")
MAX_RUNS_BYTES = 4 * 1024 * 1024


class WatchError(ValueError):
    """The watch cannot start: unknown run, bad id."""


def _now() -> datetime:
    return datetime.now(UTC)


def load_runs(project_dir: Path) -> list[dict]:
    """The runs WorkPilot recorded in `.workpilot/cicd_runs.json`, newest first."""
    path = Path(project_dir) / RUNS_FILE
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RUNS_BYTES:
        return []
    try:
        runs = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        return []
    return (
        [run for run in runs if isinstance(run, dict)] if isinstance(runs, list) else []
    )


def find_run(project_dir: Path, run_id: str) -> dict:
    if not RUN_ID.match(run_id):
        raise WatchError("invalid run id")
    for run in load_runs(project_dir):
        if run.get("id") == run_id:
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
    health, source = settings.health_url, settings.source
    if health and not is_local_host(health):
        problems.append("offline: health check skipped")
        health = ""
    if source and not source.local:
        problems.append(f"offline: {source.label} skipped")
        source = None
    return replace(settings, health_url=health, source=source)


def _measure(
    settings: WatchSettings, fetch: Fetch, now: datetime
) -> dict[str, float | None]:
    source = settings.source
    if source is None:
        return {}
    return {
        rule.name: source.value(rule.query, fetch, now) for rule in settings.metrics
    }


def _checks(
    settings: WatchSettings,
    baseline: dict[str, float | None],
    fetch: Fetch,
    now: datetime,
) -> list[MetricCheck]:
    source = settings.source
    if source is None:
        return []
    values = _measure(settings, fetch, now)
    checks = []
    for rule in settings.metrics:
        if rule.canary_query:
            # Canary analysis: the canary against the stable fleet, now.
            canary = source.value(rule.canary_query, fetch, now)
            checks.append(compare(rule, values.get(rule.name), canary))
        else:
            checks.append(compare(rule, baseline.get(rule.name), values.get(rule.name)))
    return checks


def _sample(
    settings: WatchSettings,
    baseline: dict[str, float | None],
    fetch: Fetch,
    now: datetime,
) -> dict:
    checks = _checks(settings, baseline, fetch, now)
    canaries = {rule.name for rule in settings.metrics if rule.canary_query}
    health: HealthResult | None = (
        health_check(settings.health_url, fetch) if settings.health_url else None
    )
    return {
        "at": now.isoformat(),
        "level": sample_level(checks, health).value,
        "health": health.to_dict() if health else None,
        "metrics": [
            {**c.to_dict(), **({"against": "stable"} if c.name in canaries else {})}
            for c in checks
        ],
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


def _report(
    project_dir: Path,
    state: dict,
    run: dict,
    settings: WatchSettings,
    offline: bool,
    revert_opener: OpenRevertPR | None,
    ask: Ask | None,
) -> None:
    summary = summarize(state)
    text = markdown(summary, state["run_id"])
    if state["verdict"] == Level.CRITICAL.value and settings.revert_pr:
        state["revert_pr"] = open_revert(
            state["run_id"],
            summary["deployed_sha"],
            text,
            target=str(run.get("branch") or ""),
            offline=offline,
            opener=revert_opener,
        )
    state["incident"] = {
        "summary": summary,
        "markdown": text,
        "explanation": (
            explain(summary, str(project_dir), ask) if settings.explain_incident else ""
        ),
    }


def _flag_off(
    state: dict,
    flag: RollbackFlag,
    fetch: Fetch,
    offline: bool,
    now: Callable[[], datetime],
) -> bool:
    """Turn the release's flag off; True when it is, and the rollback is that."""
    state["flag"] = turn_off(flag, fetch, offline=offline)
    if state["flag"]["status"] != "done":
        return False
    state.update(rollback="started", strategy="flag", rollback_at=now().isoformat())
    return True


def _redeploy(
    state: dict,
    env: dict,
    run: dict,
    plan: RollbackPlan,
    fetch: Fetch,
    now: Callable[[], datetime],
) -> None:
    """Run the last good deployment again."""
    if execute_rollback(env, run, plan, fetch):
        state.update(
            rollback="started", strategy="deployment", rollback_at=now().isoformat()
        )
    else:
        state["rollback"] = "failed"


def run_watch(
    project_dir: Path,
    run_id: str,
    env: dict,
    *,
    fetch: Fetch = default_fetch,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = _now,
    revert_opener: OpenRevertPR | None = None,
    ask: Ask | None = None,
    project_name: str = "",
    language: str = "en",
    smtp: SmtpFactory | None = None,
) -> dict:
    project_dir = Path(project_dir)
    run = find_run(project_dir, run_id)
    problems: list[str] = []
    offline = _offline(project_dir)
    loaded = load_settings(project_dir, env)
    problems.extend(loaded.problems)
    settings = _confine(loaded, offline, problems)
    flag = flag_from_env(env, problems)
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
        # A feature flag the rollback turns off before redeploying anything.
        "flag_configured": flag is not None,
        "problems": problems,
        "samples": [],
        "verdict": Level.UNKNOWN.value,
    }
    if not settings.configured:
        state.update(phase="done", reason="not_configured")
        _save(project_dir, state, now())
        return state

    baseline = _measure(settings, fetch, now())
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
        if levels[-1] == Level.CRITICAL and levels[-2:-1] != [Level.CRITICAL]:
            # Where the run of critical samples that ends the window began.
            state["degraded_at"] = sample["at"]
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
        if (
            flag
            and settings.auto_rollback
            and _flag_off(state, flag, fetch, offline, now)
        ):
            pass  # The flag is off: nothing is redeployed.
        elif flag and not settings.auto_rollback:
            state["rollback"] = "proposed"
        elif not plan.automatic:
            state["rollback"] = "manual"
        elif migrations:
            state["rollback"] = "blocked_migrations"
        elif settings.auto_rollback:
            _redeploy(state, env, run, plan, fetch, now)
        else:
            state["rollback"] = "proposed"
    if state["verdict"] in (Level.WARNING.value, Level.CRITICAL.value):
        # The verdict is on the page before the PR and the model are asked.
        _save(project_dir, state, now())
        _report(project_dir, state, run, settings, offline, revert_opener, ask)
        alerts = send_alerts(
            state,
            env,
            project=project_name or project_dir.name,
            language=language,
            offline=offline,
            fetch=fetch,
            **({"smtp": smtp} if smtp else {}),
        )
        if alerts:
            state["alerts"] = alerts
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
    offline = _offline(project_dir)
    plan = _plan(project_dir, env, run, offline, fetch)
    state["plan"] = plan.to_dict()
    state["migrations"] = _migrations(project_dir, plan)
    flag = flag_from_env(env, [])
    if flag and _flag_off(state, flag, fetch, offline, now):
        pass  # The flag is off: nothing is redeployed.
    elif not plan.automatic:
        state["rollback"] = "manual"
    else:
        _redeploy(state, env, run, plan, fetch, now)
    state["rollback_by"] = "person"
    _save(project_dir, state, now())
    return state
