"""What the server keeps about one person, for that person.

- :func:`visible_to`: who can read the person's usage in an organization (the
  roles holding ``usage.read``, and the platform's administrators);
- :func:`export_of`: every usage row about the person, in every organization,
  for the right of access and portability (RGPD articles 15 and 20);
- :func:`notice_due`: whether the person still has to be told what is
  measured in an organization. Each time they read the notice the server
  records ``usage.notice.seen`` in the audit log, with what was measured then:
  the proof they were told. A notice read while page activity was off is due
  again once it is turned on.
"""

from __future__ import annotations

from datetime import UTC, datetime

from server.db.models import (
    AgentRun,
    AuditLog,
    Organization,
    OrgMember,
    PageVisit,
    PresenceDay,
    Project,
    ProjectJob,
    Role,
    SpecIndex,
    UsageRecord,
    User,
)
from server.services import usage_settings
from server.services.usage_report import aware, usd
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

NOTICE_SEEN = "usage.notice.seen"
#: Rows of one kind in an export; a retention of 10 years stays far below.
MAX_ROWS = 100_000
#: What the server measures for every member, and what only once turned on.
MEASURED = ("tokens", "runs", "jobs", "sign_ins", "presence")


def _when(moment: datetime | None) -> str | None:
    return aware(moment).isoformat() if moment else None


async def visible_to(db: AsyncSession, org_id: str) -> list[str]:
    """The names of the organization's roles that read its members' usage."""
    roles = await db.scalars(
        select(Role)
        .where(or_(Role.org_id.is_(None), Role.org_id == org_id))
        .order_by(Role.name)
    )
    return [role.name for role in roles if "usage.read" in (role.permissions or [])]


async def notice_due(db: AsyncSession, user_id: str, org_id: str) -> dict:
    """What the notice says in the organization, and whether it is due."""
    settings = await usage_settings.of_org(db, org_id)
    seen = await db.scalars(
        select(AuditLog.payload).where(
            AuditLog.user_id == user_id,
            AuditLog.org_id == org_id,
            AuditLog.action == NOTICE_SEEN,
        )
    )
    told_pages = False
    told = False
    for payload in seen:
        told = True
        if isinstance(payload, dict) and payload.get("page_activity") is True:
            told_pages = True
    due = not told or (settings.page_activity and not told_pages)
    return {
        "due": due,
        "measured": list(MEASURED),
        "page_activity": settings.page_activity,
        "usage_retention_days": settings.usage_retention().days,
        "page_activity_retention_days": settings.page_activity_retention().days,
        "visible_to": await visible_to(db, org_id),
    }


async def _rows(db: AsyncSession, query) -> list:
    return list((await db.execute(query.limit(MAX_ROWS))).all())


async def export_of(db: AsyncSession, user: User) -> dict:
    """Every usage row about ``user``, in every organization, by kind."""
    orgs = dict((await db.execute(select(Organization.id, Organization.name))).all())
    projects = dict((await db.execute(select(Project.id, Project.name))).all())
    usage = await _rows(
        db,
        select(UsageRecord)
        .where(UsageRecord.user_id == user.id)
        .order_by(UsageRecord.created_at),
    )
    presence = await _rows(
        db,
        select(PresenceDay)
        .where(PresenceDay.user_id == user.id)
        .order_by(PresenceDay.day),
    )
    pages = await _rows(
        db,
        select(PageVisit).where(PageVisit.user_id == user.id).order_by(PageVisit.day),
    )
    audit = await _rows(
        db,
        select(AuditLog)
        .where(AuditLog.user_id == user.id)
        .order_by(AuditLog.created_at),
    )
    runs = await _rows(
        db,
        select(AgentRun, SpecIndex.project_id)
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .where(AgentRun.started_by == user.id)
        .order_by(AgentRun.started_at),
    )
    jobs = await _rows(
        db,
        select(ProjectJob)
        .where(ProjectJob.started_by == user.id)
        .order_by(ProjectJob.started_at),
    )
    memberships = await _rows(db, select(OrgMember).where(OrgMember.user_id == user.id))
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "account": {
            "id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "created_at": _when(user.created_at),
            "organizations": [
                {"organization": orgs.get(m.org_id), "since": _when(m.created_at)}
                for (m,) in memberships
            ],
        },
        "usage": [
            {
                "at": _when(r.created_at),
                "organization": orgs.get(r.org_id),
                "project": projects.get(r.project_id),
                "phase": r.phase,
                "agent_type": r.agent_type,
                "provider": r.provider,
                "model": r.model,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "cache_write_tokens": r.cache_write_tokens,
                "cache_read_tokens": r.cache_read_tokens,
                "cost_usd": usd(r.cost_micro_usd),
                "estimated": r.estimated,
            }
            for (r,) in usage
        ],
        "presence": [
            {
                "day": r.day.isoformat(),
                "organization": orgs.get(r.org_id),
                "last_seen_at": _when(r.last_seen_at),
            }
            for (r,) in presence
        ],
        "pages": [
            {
                "day": r.day.isoformat(),
                "organization": orgs.get(r.org_id),
                "app": r.client,
                "page": r.page,
                "opens": r.count,
            }
            for (r,) in pages
        ],
        "audit": [
            {
                "at": _when(r.created_at),
                "organization": orgs.get(r.org_id),
                "action": r.action,
                "ip": r.ip,
                "user_agent": r.user_agent,
                "login_method": r.login_method,
            }
            for (r,) in audit
        ],
        "runs": [
            {
                "started_at": _when(r.started_at),
                "finished_at": _when(r.finished_at),
                "project": projects.get(project_id),
                "phase": r.phase,
                "status": r.status,
                "provider": r.provider,
                "model": r.model,
            }
            for r, project_id in runs
        ],
        "jobs": [
            {
                "started_at": _when(r.started_at),
                "finished_at": _when(r.finished_at),
                "project": projects.get(r.project_id),
                "feature": r.feature,
                "status": r.status,
            }
            for (r,) in jobs
        ],
    }
