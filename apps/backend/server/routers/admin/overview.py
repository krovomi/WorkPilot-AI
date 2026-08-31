"""The control dashboard, the audit log and per-tenant quotas.

The dashboard aggregates data that already exists — ``agent_runs``,
``specs_index``, ``projects``, ``org_members`` — per organization. Nothing here
produces new telemetry; it answers "what is this tenant doing right now, and
how close to its ceiling", which is the question an operator actually has.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from server.auth.deps import CurrentUser
from server.authz.deps import require_org, require_permission
from server.db.engine import get_db
from server.db.models import (
    AgentRun,
    AuditLog,
    Organization,
    OrgMember,
    OrgQuota,
    Project,
    SpecIndex,
    User,
)
from server.schemas import (
    AdminOverviewResponse,
    AuditEntryPublic,
    QuotaPublic,
    UpdateQuotaRequest,
)
from server.services.audit import record
from server.services.quotas import quota_snapshot
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin:overview"])


def _org_runs_query():
    """Runs joined back to their owning organization.

    ``agent_runs`` hangs off a spec, which hangs off a project, which is what
    carries ``org_id`` — so every run statistic goes through this two-hop join.
    """
    return (
        select(AgentRun)
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
    )


@router.get("/overview", response_model=AdminOverviewResponse)
async def overview(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("analytics.read")),
    db: AsyncSession = Depends(get_db),
) -> AdminOverviewResponse:
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    now = datetime.now(UTC)
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)

    users_total = (
        await db.scalar(
            select(func.count(OrgMember.id)).where(OrgMember.org_id == org_id)
        )
    ) or 0
    users_active = (
        await db.scalar(
            select(func.count(OrgMember.id))
            .join(User, User.id == OrgMember.user_id)
            .where(OrgMember.org_id == org_id, User.is_active.is_(True))
        )
    ) or 0
    projects_total = (
        await db.scalar(
            select(func.count(Project.id)).where(Project.org_id == org_id)
        )
    ) or 0
    specs_total = (
        await db.scalar(
            select(func.count(SpecIndex.id))
            .join(Project, Project.id == SpecIndex.project_id)
            .where(Project.org_id == org_id)
        )
    ) or 0

    recent = list(
        await db.scalars(
            _org_runs_query()
            .where(Project.org_id == org_id, AgentRun.started_at >= week_ago)
            .order_by(AgentRun.started_at.desc())
        )
    )
    live = list(
        await db.scalars(
            _org_runs_query().where(
                Project.org_id == org_id,
                AgentRun.status.in_(("queued", "running")),
            )
        )
    )

    def _started_at(run: AgentRun) -> datetime:
        # SQLite hands back naive datetimes; comparing them to an aware "now"
        # raises rather than returning a wrong answer, so normalize first.
        value = run.started_at
        return value if value.tzinfo else value.replace(tzinfo=UTC)

    last_24h = [r for r in recent if _started_at(r) >= day_ago]
    finished_7d = [r for r in recent if r.status in ("succeeded", "failed")]
    succeeded_7d = [r for r in finished_7d if r.status == "succeeded"]
    success_rate = (
        round(len(succeeded_7d) / len(finished_7d), 4) if finished_7d else 0.0
    )

    by_day: Counter[str] = Counter()
    for run in recent:
        by_day[_started_at(run).date().isoformat()] += 1
    runs_by_day = [
        {
            "date": (week_ago + timedelta(days=offset)).date().isoformat(),
            "count": by_day.get(
                (week_ago + timedelta(days=offset)).date().isoformat(), 0
            ),
        }
        for offset in range(8)
    ]

    per_user: Counter[str] = Counter()
    for run in recent:
        if run.started_by:
            per_user[run.started_by] += 1
    top_users = []
    for user_id, count in per_user.most_common(5):
        user = await db.get(User, user_id)
        top_users.append(
            {
                "user_id": user_id,
                "display_name": user.display_name if user else "(removed)",
                "runs": count,
            }
        )

    recent_failures = [
        {
            "run_id": run.id,
            "phase": run.phase,
            "error": (run.error or "")[:300],
            "finished_at": (run.finished_at or run.started_at).isoformat(),
        }
        for run in recent
        if run.status == "failed"
    ][:10]

    return AdminOverviewResponse(
        org_id=org_id,
        org_name=org.name,
        users_total=users_total,
        users_active=users_active,
        projects_total=projects_total,
        specs_total=specs_total,
        runs_active=len([r for r in live if r.status == "running"]),
        runs_queued=len([r for r in live if r.status == "queued"]),
        runs_24h=len(last_24h),
        runs_failed_24h=len([r for r in last_24h if r.status == "failed"]),
        run_success_rate_7d=success_rate,
        quota=QuotaPublic(**await quota_snapshot(db, org_id)),
        runs_by_day=runs_by_day,
        runs_by_status=dict(Counter(r.status for r in recent)),
        top_users=top_users,
        recent_failures=recent_failures,
    )


# ---------------------------------------------------------------------------
# Quotas
# ---------------------------------------------------------------------------


@router.get("/quotas", response_model=QuotaPublic)
async def get_quotas(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.quota.read")),
    db: AsyncSession = Depends(get_db),
) -> QuotaPublic:
    return QuotaPublic(**await quota_snapshot(db, org_id))


@router.put("/quotas", response_model=QuotaPublic)
async def set_quotas(
    body: UpdateQuotaRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.quota.write")),
    db: AsyncSession = Depends(get_db),
) -> QuotaPublic:
    quota = await db.get(OrgQuota, org_id)
    if quota is None:
        quota = OrgQuota(org_id=org_id)
        db.add(quota)

    for field in (
        "max_users",
        "max_projects",
        "max_concurrent_runs",
        "monthly_token_budget",
        "enforce_hard_stop",
    ):
        value = getattr(body, field)
        if value is not None:
            setattr(quota, field, value)

    await record(
        db,
        action="org.quota.updated",
        actor_id=actor.id,
        org_id=org_id,
        payload=body.model_dump(exclude_none=True),
        request=request,
    )
    await db.commit()
    return QuotaPublic(**await quota_snapshot(db, org_id))


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


@router.get("/audit", response_model=list[AuditEntryPublic])
async def list_audit(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("audit.read")),
    db: AsyncSession = Depends(get_db),
    action: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[AuditEntryPublic]:
    """This organization's administrative history, newest first."""
    query = (
        select(AuditLog, User)
        .outerjoin(User, User.id == AuditLog.user_id)
        .where(AuditLog.org_id == org_id)
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if action:
        query = query.where(AuditLog.action == action)

    return [
        AuditEntryPublic(
            id=entry.id,
            user_id=entry.user_id,
            user_email=user.email if user else None,
            org_id=entry.org_id,
            project_id=entry.project_id,
            action=entry.action,
            payload=entry.payload,
            ip=entry.ip,
            created_at=entry.created_at,
        )
        for entry, user in (await db.execute(query)).all()
    ]
