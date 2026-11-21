"""The workspace views of a server project: its dashboard, its analytics, the
history of its sessions and what they cost, read from the server.

On the desktop these views read the project folder of the computer. A server
project's work happens on the server, so they are computed here, for one
project, from what the server holds: its cards (``specs_index``), the runs
started on them (``agent_runs``), its jobs (``project_jobs``), and what its
agents spent, read from the ledgers they keep in its clone
(``shared_features.usage_ledger``).

Every route takes a ``project_id``, never a path, and resolves it through
``resolve_project_scope``: another tenant's project answers 404. They read
only: ``analytics.read`` (the domain of the ``workspace`` feature), any role
on the project. An error a run or a job ended with passes through
``redact_text``; nothing served says where the clone is.

``/compare`` sets the project against the organization's other projects:
only those the person may read themselves (``load_project_scope``), only as
medians of groups of ``MIN_GROUP`` projects or more (a top tenth from
``MIN_TOP``), and never by name.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, load_project_scope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import AgentRun, Project, ProjectJob, SpecIndex, User
from server.services.project_jobs import get_project_jobs
from shared_features import build_compare, usage_ledger
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/workspace", tags=["features"])

MAX_SESSIONS = 500
MAX_ERROR = 2_000
#: The organization's other projects a comparison reads, at most; and the
#: fewest projects a group's median is given for, so that it never stands for
#: one project the person could single out.
MAX_PEERS = 100
MIN_GROUP = 5
#: The fewest projects a group's top tenth is given for: from twenty up, the
#: best tenth holds two projects or more, so it is never the best one's figure.
MIN_TOP = 20

#: The board's statuses (``implementation_plan.json``) in the words of the
#: desktop's dashboard; the others are shown as they are.
_STATUS_WORDS = {"backlog": "pending", "done": "completed"}


def _aware(moment: datetime | None) -> datetime | None:
    """A timestamp of the database in UTC (SQLite gives them back naive)."""
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _redact(text: str | None) -> str | None:
    if not text:
        return None
    from foundation.log_redaction import redact_text

    return redact_text(text)[:MAX_ERROR]


def _session(
    *,
    session_id: str,
    kind: str,
    spec: str | None,
    phase: str,
    status: str,
    started_by: str | None,
    started_at: datetime | None,
    finished_at: datetime | None,
    error: str | None,
    model: str | None = None,
) -> dict[str, Any]:
    started, finished = _aware(started_at), _aware(finished_at)
    return {
        "id": session_id,
        "kind": kind,
        "spec": spec,
        "phase": phase,
        "status": status,
        "model": model,
        "started_by": started_by,
        "started_at": started.isoformat() if started else None,
        "finished_at": finished.isoformat() if finished else None,
        "duration_seconds": int((finished - started).total_seconds())
        if started and finished
        else None,
        "tokens": None,
        "cost": None,
        "phases": [],
        "error": _redact(error),
    }


@router.get("/sessions")
async def sessions(
    limit: int = Query(default=200, ge=1, le=MAX_SESSIONS),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The project's runs and jobs, the latest first: who started what, when,
    how it ended, and for a run what its agents spent."""
    await get_project_jobs().settle_orphans(scope.project_id)
    runs = (
        await db.execute(
            select(AgentRun, SpecIndex.spec_name, User.display_name)
            .join(SpecIndex, AgentRun.spec_id == SpecIndex.id)
            .outerjoin(User, AgentRun.started_by == User.id)
            .where(SpecIndex.project_id == scope.project_id)
            .order_by(AgentRun.started_at.desc())
            .limit(limit)
        )
    ).all()
    jobs = (
        await db.execute(
            select(ProjectJob, User.display_name)
            .outerjoin(User, ProjectJob.started_by == User.id)
            .where(ProjectJob.project_id == scope.project_id)
            .order_by(ProjectJob.started_at.desc())
            .limit(limit)
        )
    ).all()
    ledgers = await asyncio.to_thread(usage_ledger.read_ledgers, scope.path)
    spent = usage_ledger.by_card(ledgers.usages)
    now = datetime.now(UTC)

    entries: list[dict[str, Any]] = []
    for run, spec_name, by in runs:
        entry = _session(
            session_id=run.id,
            kind="run",
            spec=spec_name,
            phase=run.phase,
            status=run.status,
            started_by=by,
            started_at=run.started_at,
            finished_at=run.finished_at,
            error=run.error,
            model=run.model,
        )
        start = _aware(run.started_at)
        if start is not None:
            cost = usage_ledger.spent_during(
                spent.get(spec_name, []), start, _aware(run.finished_at) or now
            )
            if cost is not None:
                entry.update(cost)
        entries.append(entry)
    for job, by in jobs:
        entries.append(
            _session(
                session_id=job.id,
                kind="job",
                spec=None,
                phase=job.feature,
                status=job.status,
                started_by=by,
                started_at=job.started_at,
                finished_at=job.finished_at,
                error=job.error,
            )
        )
    entries.sort(key=lambda e: e["started_at"] or "", reverse=True)
    return {"sessions": entries[:limit]}


@router.get("/costs")
async def costs(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """What the project's agents spent over the last thirty days."""
    ledgers = await asyncio.to_thread(usage_ledger.read_ledgers, scope.path)
    return {"summary": usage_ledger.cost_summary(ledgers.usages, datetime.now(UTC))}


@router.get("/dashboard")
async def dashboard(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The project's dashboard: its cards by status, as the board shows them,
    and what its agents spent, passed QA and merged."""
    from server.services.spec_indexer import reindex_project

    project = await db.get(Project, scope.project_id)
    if project is not None:
        await reindex_project(db, project)
    counted = await db.execute(
        select(SpecIndex.status, func.count())
        .where(SpecIndex.project_id == scope.project_id)
        .group_by(SpecIndex.status)
    )
    by_status: dict[str, int] = {}
    for status, count in counted.all():
        word = _STATUS_WORDS.get(status, status)
        by_status[word] = by_status.get(word, 0) + int(count)
    ledgers = await asyncio.to_thread(usage_ledger.read_ledgers, scope.path)
    return {"snapshot": usage_ledger.dashboard(ledgers, by_status)}


async def _readable_peers(
    db: AsyncSession, principal: Principal, scope: ProjectScope
) -> list[ProjectScope]:
    """The organization's other projects that `principal` may read."""
    listed = await db.scalars(
        select(Project.id)
        .where(Project.org_id == scope.org_id, Project.id != scope.project_id)
        .order_by(Project.created_at, Project.id)
        .limit(MAX_PEERS)
    )
    readable = []
    for project_id in listed.all():
        try:
            readable.append(await load_project_scope(db, principal, project_id))
        except HTTPException:
            continue
    return readable


@router.get("/compare")
async def compare(
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """How the project compares with its own past and with the organization's
    other projects the person may read, as medians only (see the module)."""
    peers = await _readable_peers(db, principal, scope)
    return await asyncio.to_thread(
        build_compare.compare_paths,
        scope.path,
        [peer.path for peer in peers],
        datetime.now(UTC),
        min_group=MIN_GROUP,
        min_top=MIN_TOP,
    )
