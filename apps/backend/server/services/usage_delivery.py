"""What the usage buys and who is around: the Usage tab's other views.

- :func:`delivery`: the adoption funnel (invited, joined, first sign-in, first
  task, first merge), the tasks delivered (a ``merge`` run that succeeded),
  their cost and how long they took from card to merge, and the failures
  grouped by cause;
- :func:`presence`: who is signed in now, what runs right now, and the
  accounts nobody has used for :data:`DORMANT_AFTER`.

A failure's cause is read from its error text against a closed list
(:data:`CAUSES`); the text itself never leaves the server.
"""

from __future__ import annotations

import re
import statistics
from datetime import datetime, timedelta

from server.db.models import (
    AgentRun,
    Invitation,
    OrgMember,
    PresenceDay,
    Project,
    ProjectJob,
    SpecIndex,
    UsageRecord,
    User,
)
from server.services import presence as presence_service
from server.services.usage_report import (
    Scope,
    aware,
    jobs_query,
    names_of,
    person_where,
    runs_query,
    usd,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

#: An account unused this long, by a member who joined before, is dormant.
DORMANT_AFTER = timedelta(days=30)
#: Rows of the lists of :func:`presence`.
MAX_LISTED = 500

#: The cause of a failure, by the first pattern its error text matches.
CAUSES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "usage_limit",
        re.compile(
            r"rate.?limit|usage.?limit|quota|too many requests|\b429\b|overloaded",
            re.I,
        ),
    ),
    (
        "provider_sign_in",
        re.compile(
            r"\b401\b|\b403\b|unauthori[sz]ed|forbidden|expired|invalid.{0,20}"
            r"(key|token|credential)|not (logged|signed) in|authenticat",
            re.I,
        ),
    ),
    ("timeout", re.compile(r"time.?out|timed out|deadline", re.I)),
    (
        "tests",
        re.compile(r"\btests?\b.{0,30}(fail|red)|assert|qa (rejected|failed)", re.I),
    ),
)


def cause_of(error: str | None) -> str:
    text = (error or "")[:4000]
    for cause, pattern in CAUSES:
        if pattern.search(text):
            return cause
    return "other"


async def _firsts_in(db: AsyncSession, scope: Scope, query) -> int:
    """How many people's first moment (``query``: person, min moment) is in the period."""
    count = 0
    for _user, first in await db.execute(query):
        if first is not None and scope.since <= aware(first) < scope.until:
            count += 1
    return count


async def _funnel(db: AsyncSession, scope: Scope) -> dict:
    invitations = select(func.count(Invitation.id))
    if scope.org_id:
        invitations = invitations.where(Invitation.org_id == scope.org_id)
    invited = await db.scalar(
        invitations.where(
            Invitation.created_at >= scope.since, Invitation.created_at < scope.until
        )
    )
    accepted = await db.scalar(
        invitations.where(
            Invitation.accepted_at >= scope.since, Invitation.accepted_at < scope.until
        )
    )
    first_day = select(PresenceDay.user_id, func.min(PresenceDay.last_seen_at)).where(
        PresenceDay.user_id.is_not(None), *person_where(scope, PresenceDay.user_id)
    )
    if scope.org_id:
        first_day = first_day.where(PresenceDay.org_id == scope.org_id)
    first_task = (
        select(SpecIndex.created_by, func.min(SpecIndex.created_at))
        .join(Project, Project.id == SpecIndex.project_id)
        .where(
            SpecIndex.created_by.is_not(None),
            *person_where(scope, SpecIndex.created_by),
        )
    )
    first_merge = (
        select(AgentRun.started_by, func.min(AgentRun.finished_at))
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
        .where(
            AgentRun.phase == "merge",
            AgentRun.status == "succeeded",
            AgentRun.started_by.is_not(None),
            *person_where(scope, AgentRun.started_by),
        )
    )
    if scope.org_id:
        first_task = first_task.where(Project.org_id == scope.org_id)
        first_merge = first_merge.where(Project.org_id == scope.org_id)
    return {
        "invited": int(invited or 0),
        "accepted": int(accepted or 0),
        "first_sign_in": await _firsts_in(
            db, scope, first_day.group_by(PresenceDay.user_id)
        ),
        "first_task": await _firsts_in(
            db, scope, first_task.group_by(SpecIndex.created_by)
        ),
        "first_merge": await _firsts_in(
            db, scope, first_merge.group_by(AgentRun.started_by)
        ),
    }


async def _delivered(db: AsyncSession, scope: Scope) -> dict:
    merges = await db.execute(
        runs_query(
            scope,
            AgentRun.spec_id,
            func.min(AgentRun.finished_at),
            SpecIndex.created_at,
            at=AgentRun.finished_at,
        )
        .where(AgentRun.phase == "merge", AgentRun.status == "succeeded")
        .group_by(AgentRun.spec_id, SpecIndex.created_at)
    )
    hours: list[float] = []
    specs: list[str] = []
    for spec_id, merged_at, created_at in merges:
        specs.append(spec_id)
        lead = aware(merged_at) - aware(created_at)
        hours.append(max(lead.total_seconds(), 0) / 3600)
    cost = 0
    if specs:
        cost = await db.scalar(
            select(func.coalesce(func.sum(UsageRecord.cost_micro_usd), 0))
            .join(AgentRun, AgentRun.id == UsageRecord.run_id)
            .where(AgentRun.spec_id.in_(specs))
        )
    return {
        "tasks": len(specs),
        "cost_usd": usd(cost),
        "cost_per_task_usd": usd(cost // len(specs)) if specs else None,
        "median_hours_to_merge": round(statistics.median(hours), 1) if hours else None,
    }


async def _failures(db: AsyncSession, scope: Scope) -> list[dict]:
    causes: dict[str, dict[str, int]] = {}
    runs = await db.scalars(
        runs_query(scope, AgentRun.error).where(AgentRun.status == "failed")
    )
    for error in runs:
        causes.setdefault(cause_of(error), {"runs": 0, "jobs": 0})["runs"] += 1
    jobs = await db.scalars(
        jobs_query(scope, ProjectJob.error).where(ProjectJob.status == "failed")
    )
    for error in jobs:
        causes.setdefault(cause_of(error), {"runs": 0, "jobs": 0})["jobs"] += 1
    table = [{"cause": cause, **counts} for cause, counts in causes.items()]
    return sorted(table, key=lambda r: (-(r["runs"] + r["jobs"]), r["cause"]))


async def delivery(db: AsyncSession, scope: Scope) -> dict:
    return {
        "funnel": await _funnel(db, scope),
        "delivered": await _delivered(db, scope),
        "failures": await _failures(db, scope),
    }


async def presence(db: AsyncSession, org_id: str | None, now: datetime) -> dict:
    """Who is signed in now, what runs now, and the dormant accounts."""
    recent = now - presence_service.ONLINE_WINDOW
    online_q = select(PresenceDay.user_id, func.max(PresenceDay.last_seen_at)).where(
        PresenceDay.day == now.date(),
        PresenceDay.last_seen_at >= recent,
        PresenceDay.user_id.is_not(None),
    )
    running_q = (
        select(AgentRun.phase, AgentRun.started_at, AgentRun.started_by, Project.name)
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
        .where(AgentRun.status == "running")
    )
    jobs_q = (
        select(
            ProjectJob.feature,
            ProjectJob.started_at,
            ProjectJob.started_by,
            Project.name,
        )
        .join(Project, Project.id == ProjectJob.project_id)
        .where(ProjectJob.status == "running")
    )
    last_q = select(PresenceDay.user_id, func.max(PresenceDay.last_seen_at)).where(
        PresenceDay.user_id.is_not(None)
    )
    if org_id:
        online_q = online_q.where(PresenceDay.org_id == org_id)
        running_q = running_q.where(Project.org_id == org_id)
        jobs_q = jobs_q.where(Project.org_id == org_id)
        last_q = last_q.where(PresenceDay.org_id == org_id)
        joined_q = (
            select(User.id, OrgMember.created_at)
            .join(OrgMember, OrgMember.user_id == User.id)
            .where(OrgMember.org_id == org_id, User.is_active.is_(True))
        )
    else:
        joined_q = select(User.id, User.created_at).where(User.is_active.is_(True))
    online = (await db.execute(online_q.group_by(PresenceDay.user_id))).all()
    running = [
        ("run", *row)
        for row in await db.execute(
            running_q.order_by(AgentRun.started_at).limit(MAX_LISTED)
        )
    ] + [
        ("job", *row)
        for row in await db.execute(
            jobs_q.order_by(ProjectJob.started_at).limit(MAX_LISTED)
        )
    ]
    last = dict((await db.execute(last_q.group_by(PresenceDay.user_id))).all())
    cutoff = now - DORMANT_AFTER
    dormant = [
        (user_id, last.get(user_id), joined)
        for user_id, joined in await db.execute(joined_q)
        if aware(joined) < cutoff
        and (last.get(user_id) is None or aware(last[user_id]) < cutoff)
    ]
    names = await names_of(
        db,
        {u for u, _ in online}
        | {r[3] for r in running if r[3]}
        | {u for u, _, _ in dormant},
    )

    def who(user_id: str | None) -> dict:
        user = names.get(user_id) if user_id else None
        return {
            "user_id": user_id,
            "name": user.display_name if user else None,
        }

    return {
        "online": sorted(
            ({**who(u), "last_seen_at": aware(seen).isoformat()} for u, seen in online),
            key=lambda r: r["last_seen_at"],
            reverse=True,
        )[:MAX_LISTED],
        "running": [
            {
                "kind": kind,
                "what": what,
                "started_at": aware(started).isoformat(),
                "project": project,
                **who(user_id),
            }
            for kind, what, started, user_id, project in running
        ][:MAX_LISTED],
        "dormant": sorted(
            (
                {
                    **who(u),
                    "email": names[u].email if u in names else None,
                    "last_seen_at": aware(seen).isoformat() if seen else None,
                }
                for u, seen, _ in dormant
            ),
            key=lambda r: (r["last_seen_at"] or "", r["name"] or ""),
        )[:MAX_LISTED],
        "dormant_after_days": DORMANT_AFTER.days,
    }
