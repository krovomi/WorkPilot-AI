"""Per-tenant limits.

A shared deployment needs a ceiling per organization, or one tenant's runs
starve every other: ``WORKPILOT_MAX_CONCURRENT_RUNS`` is a single global
semaphore, and without a per-org cap the first customer to queue twenty builds
owns the server.

``NULL`` on any dimension means unlimited, and an organization with no
``org_quotas`` row is unlimited on every dimension — so this is opt-in and an
upgraded deployment behaves exactly as it did.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from server.db.models import AgentRun, OrgMember, OrgQuota, Project, SpecIndex
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def get_quota(db: AsyncSession, org_id: str) -> OrgQuota | None:
    return await db.get(OrgQuota, org_id)


async def count_users(db: AsyncSession, org_id: str) -> int:
    return (
        await db.scalar(
            select(func.count(OrgMember.id)).where(OrgMember.org_id == org_id)
        )
    ) or 0


async def count_projects(db: AsyncSession, org_id: str) -> int:
    return (
        await db.scalar(select(func.count(Project.id)).where(Project.org_id == org_id))
    ) or 0


async def count_active_runs(db: AsyncSession, org_id: str) -> int:
    """Runs currently queued or executing for this organization."""
    return (
        await db.scalar(
            select(func.count(AgentRun.id))
            .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
            .join(Project, Project.id == SpecIndex.project_id)
            .where(
                Project.org_id == org_id,
                AgentRun.status.in_(("queued", "running")),
            )
        )
    ) or 0


async def tokens_used_this_month(db: AsyncSession, org_id: str) -> int:
    """Placeholder until per-run token accounting lands on ``AgentRun``.

    Returning 0 keeps the budget check inert rather than guessing: refusing a
    run on a number nobody computed would be worse than not enforcing yet.
    """
    return 0


async def enforce_project_quota(db: AsyncSession, org_id: str) -> None:
    quota = await get_quota(db, org_id)
    if quota is None or quota.max_projects is None:
        return
    if await count_projects(db, org_id) >= quota.max_projects:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Project quota reached ({quota.max_projects}). "
                "Ask an administrator to raise it."
            ),
        )


async def enforce_seat_quota(db: AsyncSession, org_id: str) -> None:
    quota = await get_quota(db, org_id)
    if quota is None or quota.max_users is None:
        return
    if await count_users(db, org_id) >= quota.max_users:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Seat quota reached ({quota.max_users}). "
                "Ask an administrator to raise it."
            ),
        )


async def enforce_run_quota(db: AsyncSession, org_id: str) -> None:
    """Refuse to start a run past the tenant's concurrency or token ceiling."""
    quota = await get_quota(db, org_id)
    if quota is None:
        return

    if quota.max_concurrent_runs is not None:
        active = await count_active_runs(db, org_id)
        if active >= quota.max_concurrent_runs:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"{active} runs already active, and this organization is "
                    f"limited to {quota.max_concurrent_runs}. Wait for one to "
                    "finish or ask an administrator to raise the limit."
                ),
            )

    if quota.monthly_token_budget is not None and quota.enforce_hard_stop:
        used = await tokens_used_this_month(db, org_id)
        if used >= quota.monthly_token_budget:
            raise HTTPException(
                status_code=402,
                detail=(
                    "The monthly token budget for this organization is spent. "
                    "Runs are blocked until it is raised or the month rolls over."
                ),
            )


async def quota_snapshot(db: AsyncSession, org_id: str) -> dict:
    """Limits plus live usage, for the administration console."""
    quota = await get_quota(db, org_id)
    return {
        "org_id": org_id,
        "max_users": quota.max_users if quota else None,
        "max_projects": quota.max_projects if quota else None,
        "max_concurrent_runs": quota.max_concurrent_runs if quota else None,
        "monthly_token_budget": quota.monthly_token_budget if quota else None,
        "enforce_hard_stop": bool(quota.enforce_hard_stop) if quota else False,
        "used_users": await count_users(db, org_id),
        "used_projects": await count_projects(db, org_id),
        "used_concurrent_runs": await count_active_runs(db, org_id),
    }


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def last_24h(now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) - timedelta(hours=24)
