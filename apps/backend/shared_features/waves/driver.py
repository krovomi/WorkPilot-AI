"""Runs "Execute in optimal order" on a server project: starts the run from a
plan the server computes itself, takes its steps, ends it.

A card is started the way the board starts it (``server.routers.specs``):
through the server's run manager, as the person who takes the step, who
must be a member of the project with ``agent.execute``. A card with a spec
builds; one without writes its spec first (and goes on to its build only when
that person's approval alone is enough). A card claimed by someone else, one
that waits for an approval, or one the run manager or the quotas refuse is
not started: the run says why, from a closed list.

A step is taken when a person asks (``POST .../run/step``, which the views do
when they open) and when a run of the project ends on the server
(``run_manager.set_run_ended_listener``): the step is then taken as the
person who started the wave run, whose rights are read again first. Steps of
one project never overlap.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from server.authz.principal import Principal
from server.authz.scope import ProjectScope
from server.db.models import AuditLog, Project, SpecIndex
from sqlalchemy.ext.asyncio import AsyncSession

from . import run_store
from .execution import NOT_STARTED, CardState, step
from .service import WaveOptions, avoided_by, build_plan, parse_options, read_cards

logger = logging.getLogger(__name__)

_locks: dict[str, asyncio.Lock] = {}
#: Projects with a wave run going on, as this process has seen them: only
#: their ended runs wake a step (a restarted server learns of a run when a
#: person opens it).
_active: set[str] = set()


def remember(project_id: str, going_on: bool) -> None:
    if going_on:
        _active.add(project_id)
    else:
        _active.discard(project_id)


def project_lock(project_id: str) -> asyncio.Lock:
    lock = _locks.get(project_id)
    if lock is None:
        lock = _locks[project_id] = asyncio.Lock()
    return lock


async def board(
    db: AsyncSession, project: Project, scope: ProjectScope
) -> tuple[dict[str, CardState], dict[str, SpecIndex], dict[str, Any]]:
    """The cards as a step sees them, their index rows, and what the clone says of each."""
    from server.services.run_manager import get_run_manager
    from server.services.spec_indexer import reindex_project

    rows = {row.spec_name: row for row in await reindex_project(db, project)}
    cards = await asyncio.to_thread(read_cards, scope.path, project.default_branch)
    manager = get_run_manager()
    states = {
        card.id: CardState(
            column=card.column,
            archived=card.archived,
            abandoned=card.abandoned,
            blocked_by=tuple(card.blocked_by),
            running=card.id in rows and manager.is_running(rows[card.id].id),
        )
        for card in cards
    }
    return states, rows, {card.id: card for card in cards}


def _options(run: dict[str, Any]) -> WaveOptions:
    return parse_options(run.get("options")) or WaveOptions()


async def _start_card(
    db: AsyncSession,
    project: Project,
    actor: Principal,
    row: SpecIndex | None,
    card: Any,
) -> str | None:
    """Starts one card as ``actor``; the reason it was not started, or None."""
    from server.authz.approvals import may_approve_alone
    from server.services.run_manager import RunManagerError, get_run_manager
    from shared_board.review import _approval_valid
    from shared_features.waves.service import read_json

    if row is None:
        return "missing"
    if row.claimed_by and row.claimed_by != actor.id:
        return "claimed"
    manager = get_run_manager()
    if manager.is_running(row.id):
        return "already_running"
    card_dir = Path(project.server_path) / ".workpilot" / "specs" / card.id
    may_skip_review = False
    if card.has_spec:
        phase = "build"
        meta = await asyncio.to_thread(read_json, card_dir / "task_metadata.json")
        needs_review = meta.get("requireReviewBeforeCoding", True) is not False
        if needs_review and not await asyncio.to_thread(_approval_valid, card_dir):
            return "needs_approval"
    else:
        phase = "spec"
        may_skip_review = await may_approve_alone(
            db,
            principal=actor,
            project_id=project.id,
            org_id=project.org_id,
            author_id=row.created_by,
            spec_name=row.spec_name,
            card_dir=card_dir,
        )
    try:
        run = await manager.start_run(
            spec=row,
            project_id=project.id,
            server_path=project.server_path,
            phase=phase,
            user_id=actor.id,
            org_id=project.org_id,
            may_skip_review=may_skip_review,
        )
    except RunManagerError:
        return "refused"
    except HTTPException as error:
        return "quota" if error.status_code in (402, 429) else "refused"
    # Claimed once started, as the board's start claims it: a refused start
    # leaves the card as it was, and the session as it was.
    if row.claimed_by is None:
        row.claimed_by = actor.id
        row.claimed_at = datetime.now(UTC)
    db.add(
        AuditLog(
            user_id=actor.id,
            org_id=project.org_id,
            project_id=project.id,
            action="spec.run.started",
            payload={
                "spec": card.id,
                "phase": phase,
                "run_id": run.id,
                "execution_waves": True,
            },
        )
    )
    await db.commit()
    return None


async def advance(
    db: AsyncSession,
    project: Project,
    scope: ProjectScope,
    actor: Principal,
    run: dict[str, Any],
) -> dict[str, Any]:
    """Takes the run's steps until it waits; ``{"run", "blocked", "ended"}``."""
    now = datetime.now(UTC)
    blocked: list[str] = []
    # A wave that settles leads to the next one at once; bounded by the waves.
    for _ in range(len(run["waves"]) + 2):
        states, rows, cards = await board(db, project, scope)
        current = step(run, states)
        if current.finished:
            await asyncio.to_thread(run_store.end_run, scope.path, run, "done", now)
            remember(project.id, False)
            return {"run": None, "blocked": [], "ended": "done"}
        if current.wave_settled:
            run = await _next_wave(project, scope, run, states)
            run = await asyncio.to_thread(run_store.save_run, scope.path, run, now)
            continue
        blocked = current.blocked
        if not current.promote:
            break
        run = {**run, "started": [*run["started"], *current.promote]}
        run = await asyncio.to_thread(run_store.save_run, scope.path, run, now)
        refused: dict[str, str] = {}
        for card_id in current.promote:
            reason = await _start_card(
                db, project, actor, rows.get(card_id), cards.get(card_id)
            )
            if reason:
                refused[card_id] = reason
        run = {**run, "failures": {**(run.get("failures") or {}), **refused}}
        run = await asyncio.to_thread(run_store.save_run, scope.path, run, now)
        if not refused:
            break
        # A refused start leaves its card in the backlog, which settles it:
        # look again, since no run will end to wake the run.
    remember(project.id, True)
    return {"run": run, "blocked": blocked, "ended": None}


async def _next_wave(
    project: Project,
    scope: ProjectScope,
    run: dict[str, Any],
    states: dict[str, CardState],
) -> dict[str, Any]:
    """The next wave, planned again from what the cards that ran changed; the
    waves planned before when nothing is left or the plan gives none."""
    following = run["current"] + 1
    remaining = [
        card_id
        for wave in run["waves"][following:]
        for card_id in wave
        if card_id in states and states[card_id].column in NOT_STARTED
    ]
    if not remaining:
        return {**run, "current": following}
    plan = await asyncio.to_thread(
        build_plan, scope.path, project.default_branch, _options(run), remaining
    )
    replanned = [list(w["taskIds"]) for w in plan["waves"]]
    if not replanned:
        return {**run, "current": following}
    return {
        **run,
        "waves": [*run["waves"][:following], *replanned],
        "current": following,
    }


async def start(
    db: AsyncSession,
    project: Project,
    scope: ProjectScope,
    actor: Principal,
    options: WaveOptions,
    advance_when: str,
) -> dict[str, Any]:
    """A new run from the plan of the backlog, started at once."""
    known = await asyncio.to_thread(
        lambda: {c.id for c in read_cards(scope.path, project.default_branch)}
    )
    existing, _ignored = await asyncio.to_thread(
        run_store.load_run, scope.path, project.id, known
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="A run is already going on")
    plan = await asyncio.to_thread(
        build_plan, scope.path, project.default_branch, options
    )
    waves = [list(w["taskIds"]) for w in plan["waves"]]
    if not waves:
        raise HTTPException(status_code=409, detail="Nothing to plan")
    run = {
        "projectId": project.id,
        "waves": waves,
        "current": 0,
        "advanceWhen": advance_when,
        "maxParallel": options.max_parallel,
        "started": [],
        "avoided": avoided_by(plan),
        "startedBy": actor.id,
        "failures": {},
        "options": options.as_dict(),
    }
    run = await asyncio.to_thread(
        run_store.save_run, scope.path, run, datetime.now(UTC)
    )
    return await advance(db, project, scope, actor, run)


async def advance_as_owner(project_id: str) -> None:
    """After a run of the project ended: the wave run's next step, as the
    person who started it, if they may still start runs on the project."""
    from server.authz.scope import load_project_scope
    from server.db.engine import get_session_factory
    from shared_features.automations.live import owner_principal

    async with project_lock(project_id), get_session_factory()() as db:
        project = await db.get(Project, project_id)
        if project is None:
            return
        root = Path(project.server_path)
        known = await asyncio.to_thread(
            lambda: {c.id for c in read_cards(root, project.default_branch)}
        )
        run, _ignored = await asyncio.to_thread(
            run_store.load_run, root, project.id, known
        )
        if run is None:
            remember(project_id, False)
            return
        owner = await owner_principal(db, run.get("startedBy"), project)
        if owner is None or not owner.has("agent.execute"):
            return
        # ``owner_principal`` checked the project and the role just now.
        scope = await load_project_scope(db, owner, project.id)
        await advance(db, project, scope, owner, run)


def on_run_ended(project_id: str) -> None:
    """The run manager's listener: the step runs beside, never in its way."""
    if project_id not in _active:
        return
    # Called from the run manager's own task: a loop is running.
    task = asyncio.get_running_loop().create_task(advance_as_owner(project_id))
    task.add_done_callback(_log_failure)


def _log_failure(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        logger.warning(
            "Execution waves step failed: %s", type(task.exception()).__name__
        )
