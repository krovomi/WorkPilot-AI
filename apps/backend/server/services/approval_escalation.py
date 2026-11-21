"""Escalating a plan that waited too long for its approvals.

A server card whose spec run ended with a plan to approve waits for the
approvals its criticality asks for (``server/authz/approvals.py``). When it
has waited longer than the deployment allows for that criticality
(``WORKPILOT_APPROVAL_ESCALATION_HOURS``), a second group of approvers hears
of it on their "needs you" channels (``approval_escalated``): the people of
the organization who hold one of ``WORKPILOT_APPROVAL_ESCALATION_ROLES``
(``owner`` and ``admin`` unless set) and may approve on the project, other
than the card's author and those who already approved it.

The wait starts when the spec run ended: the server wrote that time
(``agent_runs``), no client and no run can move it. A card escalates once
per spec run (``approval_escalations``); a new spec run starts a new wait.
Each escalation goes to the organization's audit log (``review.escalated``).

The server had no periodic job: :func:`start` runs :func:`sweep` every few
minutes in the server's event loop while server mode is mounted and
escalation is on. Each sweep is bounded (cards looked at, people told), and
a failed one is logged by its type and tried again at the next turn: a
notification never takes the server down.

Whether a card still waits is the board's answer (``push.awaits_approval``,
installed by ``shared_board.api``): the server imports no feature unit.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from server.authz.approval_policy import content_hash
from server.authz.approvals import approval_status, role_slugs
from server.authz.delegation import aware
from server.authz.self_approval import holds_approval
from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import (
    AgentRun,
    ApprovalEscalation,
    OrgMember,
    Project,
    SpecApproval,
    SpecIndex,
)
from server.services import audit, needs_you, push
from server.services import needs_you_send as channels
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

EVENT = "approval_escalated"
#: How often the server looks for cards that waited too long.
INTERVAL_SECONDS = 300.0
#: Cards looked at in one sweep, and people told of one card.
MAX_CARDS = 100
MAX_RECIPIENTS = 20
#: Members of an organization looked at for its second group.
MAX_MEMBERS = 500
#: A wait older than this is not looked at any more.
WINDOW = timedelta(days=60)

_task: asyncio.Task | None = None


def _waits(now: datetime):
    """Spec runs that succeeded and are the last run of their card, oldest first.

    A card that went on to a build, or whose spec ran again, has a later run.
    """
    hours = [h for _, h in get_settings().approval_escalation_hours if h]
    shortest = timedelta(hours=min(hours))
    latest = (
        select(AgentRun.spec_id, func.max(AgentRun.started_at).label("last"))
        .group_by(AgentRun.spec_id)
        .subquery()
    )
    return (
        select(AgentRun, SpecIndex, Project)
        .join(
            latest,
            (latest.c.spec_id == AgentRun.spec_id)
            & (latest.c.last == AgentRun.started_at),
        )
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
        .outerjoin(ApprovalEscalation, ApprovalEscalation.run_id == AgentRun.id)
        .where(
            AgentRun.phase == "spec",
            AgentRun.status == "succeeded",
            AgentRun.finished_at.is_not(None),
            AgentRun.finished_at <= now - shortest,
            AgentRun.finished_at >= now - WINDOW,
            ApprovalEscalation.run_id.is_(None),
            Project.server_path.is_not(None),
        )
        .order_by(AgentRun.finished_at)
        .limit(MAX_CARDS)
    )


async def second_group(
    db: AsyncSession,
    *,
    project: Project,
    spec_name: str,
    card_dir: Path,
    author_id: str | None,
) -> list[str]:
    """Who hears of this card: holders of an escalation role who may approve it."""
    roles = set(get_settings().approval_escalation_roles)
    approved = set(
        await db.scalars(
            select(SpecApproval.user_id).where(
                SpecApproval.project_id == project.id,
                SpecApproval.spec_name == spec_name,
                SpecApproval.content_hash == content_hash(card_dir),
            )
        )
    )
    members = await db.scalars(
        select(OrgMember.user_id)
        .where(OrgMember.org_id == project.org_id)
        .order_by(OrgMember.user_id)
        .limit(MAX_MEMBERS)
    )
    found: list[str] = []
    for user_id in members:
        if user_id == author_id or user_id in approved:
            continue
        held = await role_slugs(
            db, user_id=user_id, org_id=project.org_id, project_id=project.id
        )
        if not roles & set(held):
            continue
        if await holds_approval(
            db, project_id=project.id, org_id=project.org_id, user_id=user_id
        ):
            found.append(user_id)
            if len(found) >= MAX_RECIPIENTS:
                break
    return found


async def _escalate(
    db: AsyncSession,
    run: AgentRun,
    card: SpecIndex,
    project: Project,
    now: datetime,
    client: httpx.AsyncClient | None,
    resolver: channels.Resolver,
) -> bool:
    server_path = project.server_path or ""
    if not push.awaits_approval(server_path, card.spec_name):
        return False
    card_dir = (Path(server_path) / ".workpilot" / "specs" / card.spec_name).resolve()
    status = await approval_status(
        db, project_id=project.id, spec_name=card.spec_name, card_dir=card_dir
    )
    if status.complete:
        return False
    hours = dict(get_settings().approval_escalation_hours)[status.criticality]
    waited = now - aware(run.finished_at or now)
    if not hours or waited < timedelta(hours=hours):
        return False
    people = await second_group(
        db,
        project=project,
        spec_name=card.spec_name,
        card_dir=card_dir,
        author_id=card.created_by,
    )
    told = await needs_you.notify_people(
        db, people, EVENT, project.name, card.spec_name, client, resolver
    )
    db.add(
        ApprovalEscalation(
            run_id=run.id,
            project_id=project.id,
            spec_name=card.spec_name,
            criticality=status.criticality,
            notified=told,
            escalated_at=now,
        )
    )
    await audit.record(
        db,
        action="review.escalated",
        actor_id=None,
        org_id=project.org_id,
        project_id=project.id,
        payload={
            "spec": card.spec_name,
            "criticality": status.criticality,
            "waited_hours": int(waited.total_seconds() // 3600),
            "count": len(status.approvals),
            "needed": status.requirement.needed,
            "recipients": len(people),
            "notified": told,
        },
    )
    await db.commit()
    return True


async def sweep(
    *,
    now: datetime | None = None,
    client: httpx.AsyncClient | None = None,
    resolver: channels.Resolver = channels.system_resolver,
) -> int:
    """Escalate every card that waited too long; how many were."""
    if not get_settings().escalation_enabled:
        return 0
    now = now or datetime.now(UTC)
    escalated = 0
    async with get_session_factory()() as db:
        rows = (await db.execute(_waits(now))).all()
        for run, card, project in rows:
            escalated += await _escalate(db, run, card, project, now, client, resolver)
    return escalated


async def _loop(ready: Callable[[], Awaitable[None]] | None, interval: float) -> None:
    while True:
        try:
            if ready is not None:
                await ready()
            await sweep()
        # The type only: a message could carry a destination.
        except (SQLAlchemyError, httpx.HTTPError, OSError, ValueError) as e:
            logger.warning("Approval escalation sweep failed: %s", type(e).__name__)
        await asyncio.sleep(interval)


def start(
    ready: Callable[[], Awaitable[None]] | None = None,
    interval: float = INTERVAL_SECONDS,
) -> asyncio.Task | None:
    """Run the sweep periodically in this event loop; None when escalation is off."""
    global _task
    if not get_settings().escalation_enabled:
        return None
    if _task is not None and not _task.done():
        return _task
    _task = asyncio.get_running_loop().create_task(_loop(ready, interval))
    return _task


async def stop() -> None:
    """Stop the periodic sweep, if it runs."""
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
