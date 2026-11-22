"""Roll a linked service back with the one that failed (#366).

In the app, a person links projects: when this one rolls back, the services
that depend on it go back too (the frontend with its backend). The links live
in the app's own settings, never in a repository, so a committed file cannot
roll another project back. The app calls this, one project at a time, with
that project's own CI/CD settings and the moment the failed service goes
back to (`since`: when its last good run was created).

Everything the project deployed through WorkPilot since then goes back: the
earliest run recorded at or after `since` is rolled back like a watched one,
to the last run of its pipeline that succeeded before it. No such run means
the service has not changed since, and nothing is done. A migration in the
changes, a provider that cannot roll back by API or a strict offline policy
leave it to a person, as for the watch itself.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from .collectors import Fetch, default_fetch
from .rollback import _when, execute_rollback
from .watch import (
    RUN_ID,
    WatchError,
    _migrations,
    _now,
    _offline,
    _plan,
    _save,
    load_runs,
    read_state,
)

# A run that was never triggered deployed nothing.
_DEPLOYED = frozenset({"triggered", "running", "success"})
MAX_CAUSE = 100


def _earliest_since(runs: list[dict], since: datetime) -> dict | None:
    deployed = []
    for run in runs:
        at = _when(run.get("triggered_at"))
        deployed_run = run.get("status") in _DEPLOYED
        if at and at >= since and deployed_run and RUN_ID.match(str(run.get("id"))):
            deployed.append((at, run))
    return min(deployed, key=lambda item: item[0])[1] if deployed else None


def run_linked_rollback(
    project_dir: Path,
    since: str,
    env: dict,
    *,
    cause: str = "",
    fetch: Fetch = default_fetch,
    now: Callable[[], datetime] = _now,
) -> dict:
    """Roll this project back to where it was at `since`; what became of it."""
    project_dir = Path(project_dir)
    moment = _when(since)
    if moment is None:
        raise WatchError("invalid time")
    run = _earliest_since(load_runs(project_dir), moment)
    if run is None:
        return {"status": "not_deployed_since"}
    run_id = str(run["id"])
    plan = _plan(project_dir, env, run, _offline(project_dir), fetch)
    migrations = _migrations(project_dir, plan)
    if not plan.automatic:
        status = "manual"
    elif migrations:
        status = "blocked_migrations"
    else:
        status = "started" if execute_rollback(env, run, plan, fetch) else "failed"
    result = {
        "status": status,
        "run_id": run_id,
        "plan": plan.to_dict(),
        "migrations": migrations,
    }
    state = read_state(project_dir, run_id)
    if state is not None and state.get("phase") != "done":
        # Its own watch is still writing this state.
        return result
    state = state or {
        "run_id": run_id,
        "provider": run.get("provider", ""),
        "started_at": now().isoformat(),
        "phase": "done",
        "verdict": "unknown",
        "reason": "linked_rollback",
        "problems": [],
        "samples": [],
    }
    state.update(
        rollback=status,
        rollback_by="linked",
        linked_cause=cause[:MAX_CAUSE],
        plan=result["plan"],
        migrations=migrations,
    )
    if status == "started":
        state["rollback_at"] = now().isoformat()
    _save(project_dir, state, now())
    return result
