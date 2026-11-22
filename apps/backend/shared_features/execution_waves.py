"""Execution waves of a server project (Conflict Predictor, issue #358): the
plan of its backlog, "Execute in optimal order" and the run's history.

The planner, the merge check, the fragile zones and the code links are the
desktop's, ported (``shared_features.waves``); they read the server's clone.
The run and its history live in the clone's ``.workpilot``
(``waves.run_store``), and the server takes the run's steps
(``waves.driver``).

Every route takes a ``project_id``, never a path, and resolves it through
``resolve_project_scope``. Reading the plan, the run and the history is
``task.read`` (the ``execution_waves`` feature answers to the ``task``
domain). Starting a run and taking a step start agents: ``agent.execute``
(``ROUTE_OVERRIDES``), and a project role of member. Stopping the run is
``task.write`` and a member: running cards keep going. Options are bounded
numbers and closed lists, checked before anything is read.
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project
from server.services.run_manager import set_run_ended_listener
from shared_board.cards import _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

from .waves import conflict_times, driver, run_store
from .waves.service import (
    MAX_DRIFT_THRESHOLD,
    MAX_PARALLEL_CEILING,
    MAX_TOLERANCE,
    WaveOptions,
    build_plan,
    read_cards,
)

router = APIRouter(prefix="/api/features/execution-waves", tags=["features"])

# A run of the project that ends on the server takes the wave run's next step.
set_run_ended_listener(driver.on_run_ended)

UNAVAILABLE = "Run file unavailable"


class OptionsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tolerance: float = Field(default=0, ge=0, le=MAX_TOLERANCE)
    unplannedPolicy: Literal["isolate", "independent"] = "isolate"  # noqa: N815
    driftThreshold: float = Field(default=3, ge=0, le=MAX_DRIFT_THRESHOLD)  # noqa: N815
    fragileZones: bool = True  # noqa: N815
    codeLinks: bool = True  # noqa: N815
    maxParallel: int = Field(default=3, ge=1, le=MAX_PARALLEL_CEILING)  # noqa: N815

    def options(self) -> WaveOptions:
        return WaveOptions(
            tolerance=self.tolerance,
            unplanned_policy=self.unplannedPolicy,
            drift_threshold=self.driftThreshold,
            fragile_zones=self.fragileZones,
            code_links=self.codeLinks,
            max_parallel=self.maxParallel,
        )


class StartBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    options: OptionsBody = Field(default_factory=OptionsBody)
    advanceWhen: Literal["merged", "review"] = "merged"  # noqa: N815


async def _project(db: AsyncSession, scope: ProjectScope) -> Project:
    project = await db.get(Project, scope.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _within_quota(db: AsyncSession, org_id: str, wanted: int) -> int:
    """The parallelism asked, never above the organization's run ceiling."""
    from server.services.quotas import get_quota

    quota = await get_quota(db, org_id)
    ceiling = quota.max_concurrent_runs if quota else None
    return max(1, min(wanted, ceiling)) if ceiling else wanted


@router.get("/plan")
async def plan(
    tolerance: float = Query(default=0, ge=0, le=MAX_TOLERANCE),
    unplanned_policy: Literal["isolate", "independent"] = "isolate",
    drift_threshold: float = Query(default=3, ge=0, le=MAX_DRIFT_THRESHOLD),
    fragile_zones: bool = True,
    code_links: bool = True,
    max_parallel: int = Query(default=3, ge=1, le=MAX_PARALLEL_CEILING),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The waves of the project's backlog and queue, as they stand now."""
    project = await _project(db, scope)
    options = WaveOptions(
        tolerance=tolerance,
        unplanned_policy=unplanned_policy,
        drift_threshold=drift_threshold,
        fragile_zones=fragile_zones,
        code_links=code_links,
        max_parallel=await _within_quota(db, project.org_id, max_parallel),
    )
    result = await asyncio.to_thread(
        build_plan, scope.path, project.default_branch, options
    )
    return {"projectId": project.id, **result}


def _run_cards(cards: dict[str, Any], states: dict[str, Any], run: dict[str, Any]):
    return [
        {
            "id": card_id,
            "title": cards[card_id].title if card_id in cards else card_id,
            "column": states[card_id].column if card_id in states else None,
            "running": states[card_id].running if card_id in states else False,
        }
        for wave in run["waves"]
        for card_id in wave
    ]


async def _answer(
    db: AsyncSession, project: Project, scope: ProjectScope, outcome: dict[str, Any]
) -> dict[str, Any]:
    run = outcome.get("run")
    if run is None:
        return {"run": None, "ended": outcome.get("ended"), "ignored": False}
    states, _rows, cards = await driver.board(db, project, scope)
    return {
        "run": {k: v for k, v in run.items() if k != "startedBy"},
        "cards": _run_cards(cards, states, run),
        "blocked": outcome.get("blocked", []),
        "ended": None,
        "ignored": False,
    }


async def _saved(scope: ProjectScope, project: Project) -> tuple[dict | None, bool]:
    def load() -> tuple[dict | None, bool]:
        known = {c.id for c in read_cards(scope.path, project.default_branch)}
        return run_store.load_run(scope.path, project.id, known)

    return await asyncio.to_thread(load)


@router.get("/run")
async def get_run(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The run going on, with each of its cards' column; none when there is none."""
    project = await _project(db, scope)
    run, ignored = await _saved(scope, project)
    driver.remember(project.id, run is not None)
    if run is None:
        return {"run": None, "ended": None, "ignored": ignored}
    return await _answer(db, project, scope, {"run": run})


@router.post("/run")
async def start_run(
    body: StartBody,
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Plans the backlog and starts its first wave, as the caller."""
    _require_writer(scope, principal)
    project = await _project(db, scope)
    options = body.options.options()
    parallel = await _within_quota(db, project.org_id, options.max_parallel)
    options = dataclasses.replace(options, max_parallel=parallel)
    async with driver.project_lock(project.id):
        try:
            outcome = await driver.start(
                db, project, scope, principal, options, body.advanceWhen
            )
        except (run_store.StoreRefused, OSError):
            raise HTTPException(status_code=409, detail=UNAVAILABLE) from None
    return await _answer(db, project, scope, outcome)


@router.post("/run/step")
async def step_run(
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Starts what may start now, and moves to the next wave once this one settled."""
    _require_writer(scope, principal)
    project = await _project(db, scope)
    async with driver.project_lock(project.id):
        run, ignored = await _saved(scope, project)
        if run is None:
            return {"run": None, "ended": None, "ignored": ignored}
        try:
            outcome = await driver.advance(db, project, scope, principal, run)
        except (run_store.StoreRefused, OSError):
            raise HTTPException(status_code=409, detail=UNAVAILABLE) from None
    return await _answer(db, project, scope, outcome)


@router.delete("/run")
async def stop_run(
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Ends the run (recorded as stopped); the cards it started keep running."""
    _require_writer(scope, principal)
    project = await _project(db, scope)
    async with driver.project_lock(project.id):
        run, _ignored = await _saved(scope, project)
        if run is None:
            raise HTTPException(status_code=404, detail="No run going on")
        try:
            await asyncio.to_thread(
                run_store.end_run, scope.path, run, "stopped", datetime.now(UTC)
            )
        except (run_store.StoreRefused, OSError):
            raise HTTPException(status_code=409, detail=UNAVAILABLE) from None
        driver.remember(project.id, False)
    return {"run": None, "ended": "stopped", "ignored": False}


@router.get("/history")
async def history(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The runs that ended, newest first, the last 14 days in counts, and how
    long the merge conflicts of those days took to resolve (measured)."""
    recorded = await asyncio.to_thread(run_store.load_history, scope.path)
    times = await asyncio.to_thread(conflict_times.load_times, scope.path)
    now = datetime.now(UTC)
    return {
        **recorded,
        "summary": run_store.sprint_summary(recorded, now),
        "conflicts": conflict_times.resolution_summary(times, now),
    }
