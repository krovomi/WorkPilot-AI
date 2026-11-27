"""The figures of the Usage tab, computed by the server from what it keeps.

Each function answers one view of ``/admin/usage/*`` for a :class:`Scope`: an
organization (or the whole platform), a period of days and the filters the
administrator picked (person, group, project, provider, model). The rows come
from ``usage_records`` (lot 1), ``presence_days`` (lot 2), ``page_visits``
(lot 3), the runs and jobs, and the audit log: totals, names and action names,
never a prompt, a payload, an address or an error text.

A filter applies where it means something: the provider and the model to
token counts and to the runs and jobs those tokens belong to, the project to
everything tied to a project, the person and the group to everything. Days
are UTC days, as the server stores them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from server.db.models import (
    AgentRun,
    AuditLog,
    GroupMember,
    OrgMember,
    OrgQuota,
    PageVisit,
    PresenceDay,
    Project,
    ProjectJob,
    SpecIndex,
    UsageRecord,
    User,
)
from server.services import usage_settings
from server.services.quotas import tokens_used_this_month
from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

#: The longest period one view covers, as the longest retention.
MAX_PERIOD_DAYS = usage_settings.MAX_DAYS
#: Rows of the per-person table, and events of one person's timeline.
MAX_PEOPLE = 1000
MAX_TIMELINE = 300
#: Sign-ins are audit entries under these actions (``auth/sign_in.py``).
SIGN_IN_PREFIX = "auth.login"

TOKENS = (
    UsageRecord.input_tokens
    + UsageRecord.output_tokens
    + UsageRecord.cache_write_tokens
    + UsageRecord.cache_read_tokens
)


@dataclass(frozen=True)
class Scope:
    """Whose figures, over which days (``end`` included), with which filters.

    ``org_id`` None is the whole platform, offered to its administrators only.
    """

    org_id: str | None
    start: date
    end: date
    user_id: str | None = None
    group_id: str | None = None
    project_id: str | None = None
    provider: str | None = None
    model: str | None = None

    @property
    def since(self) -> datetime:
        return datetime.combine(self.start, time.min, UTC)

    @property
    def until(self) -> datetime:
        return datetime.combine(self.end + timedelta(days=1), time.min, UTC)

    @property
    def by_engine(self) -> bool:
        return bool(self.provider or self.model)

    def of_person(self, user_id: str) -> Scope:
        return Scope(
            self.org_id,
            self.start,
            self.end,
            user_id=user_id,
            project_id=self.project_id,
            provider=self.provider,
            model=self.model,
        )


def usd(micro: int | None) -> float:
    return round((micro or 0) / 1_000_000, 6)


def rate(succeeded: int, failed: int) -> float | None:
    """Successes among the runs that ended either way; None before any."""
    ended = succeeded + failed
    return round(succeeded / ended, 4) if ended else None


def day_of(column: ColumnElement, dialect: str) -> ColumnElement:
    """The UTC day of a timestamp, as ``YYYY-MM-DD``, in the database's words."""
    if dialect == "postgresql":
        return func.to_char(func.timezone("UTC", column), "YYYY-MM-DD")
    return func.date(column)


def dialect_of(db: AsyncSession) -> str:
    return db.get_bind().dialect.name


def _group_people(group_id: str) -> Select:
    return select(GroupMember.user_id).where(GroupMember.group_id == group_id)


def person_where(scope: Scope, column: ColumnElement) -> list[ColumnElement]:
    """The person and group filters, on the column that names the person."""
    where: list[ColumnElement] = []
    if scope.user_id:
        where.append(column == scope.user_id)
    if scope.group_id:
        where.append(column.in_(_group_people(scope.group_id)))
    return where


def _engine(scope: Scope) -> list[ColumnElement]:
    where: list[ColumnElement] = []
    if scope.provider:
        where.append(UsageRecord.provider == scope.provider)
    if scope.model:
        where.append(UsageRecord.model == scope.model)
    return where


def usage_where(scope: Scope) -> list[ColumnElement]:
    where = [
        UsageRecord.created_at >= scope.since,
        UsageRecord.created_at < scope.until,
        *person_where(scope, UsageRecord.user_id),
        *_engine(scope),
    ]
    if scope.org_id:
        where.append(UsageRecord.org_id == scope.org_id)
    if scope.project_id:
        where.append(UsageRecord.project_id == scope.project_id)
    return where


def runs_query(scope: Scope, *columns, at: ColumnElement | None = None) -> Select:
    """``columns`` of the runs started in the period (or ``at`` in it)."""
    moment = AgentRun.started_at if at is None else at
    query = (
        select(*columns)
        .select_from(AgentRun)
        .join(SpecIndex, SpecIndex.id == AgentRun.spec_id)
        .join(Project, Project.id == SpecIndex.project_id)
        .where(
            moment >= scope.since,
            moment < scope.until,
            *person_where(scope, AgentRun.started_by),
        )
    )
    if scope.org_id:
        query = query.where(Project.org_id == scope.org_id)
    if scope.project_id:
        query = query.where(Project.id == scope.project_id)
    if scope.by_engine:
        query = query.where(
            AgentRun.id.in_(select(UsageRecord.run_id).where(*_engine(scope)))
        )
    return query


def jobs_query(scope: Scope, *columns) -> Select:
    query = (
        select(*columns)
        .select_from(ProjectJob)
        .join(Project, Project.id == ProjectJob.project_id)
        .where(
            ProjectJob.started_at >= scope.since,
            ProjectJob.started_at < scope.until,
            *person_where(scope, ProjectJob.started_by),
        )
    )
    if scope.org_id:
        query = query.where(Project.org_id == scope.org_id)
    if scope.project_id:
        query = query.where(Project.id == scope.project_id)
    if scope.by_engine:
        query = query.where(
            ProjectJob.id.in_(select(UsageRecord.job_id).where(*_engine(scope)))
        )
    return query


def _presence_where(scope: Scope) -> list[ColumnElement]:
    where = person_where(scope, PresenceDay.user_id)
    if scope.org_id:
        where.append(PresenceDay.org_id == scope.org_id)
    return where


async def _statuses(db: AsyncSession, query: Select) -> dict[str, int]:
    rows = await db.execute(query)
    return {status: count for status, count in rows}


def _ended(counts: dict[str, int]) -> dict:
    succeeded = counts.get("succeeded", 0)
    failed = counts.get("failed", 0)
    return {
        "total": sum(counts.values()),
        "succeeded": succeeded,
        "failed": failed,
        "cancelled": counts.get("cancelled", 0),
        "success_rate": rate(succeeded, failed),
    }


async def _active(db: AsyncSession, scope: Scope, days: int) -> int:
    first = scope.end - timedelta(days=days - 1)
    count = await db.scalar(
        select(func.count(func.distinct(PresenceDay.user_id))).where(
            PresenceDay.day >= first,
            PresenceDay.day <= scope.end,
            PresenceDay.user_id.is_not(None),
            *_presence_where(scope),
        )
    )
    return int(count or 0)


async def _budget(db: AsyncSession, org_id: str | None) -> dict | None:
    if org_id is None:
        return None
    budget = await db.scalar(
        select(OrgQuota.monthly_token_budget).where(OrgQuota.org_id == org_id)
    )
    used = await tokens_used_this_month(db, org_id)
    return {
        "monthly_token_budget": budget,
        "used_this_month": used,
        "percent": round(100 * used / budget, 1) if budget else None,
    }


async def summary(db: AsyncSession, scope: Scope) -> dict:
    """The key figures: tokens, cost, budget, active people, runs and jobs."""
    tokens = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageRecord.input_tokens), 0),
                func.coalesce(func.sum(UsageRecord.output_tokens), 0),
                func.coalesce(func.sum(UsageRecord.cache_write_tokens), 0),
                func.coalesce(func.sum(UsageRecord.cache_read_tokens), 0),
                func.coalesce(func.sum(UsageRecord.cost_micro_usd), 0),
                func.count(UsageRecord.id),
                func.coalesce(func.max(UsageRecord.estimated), False),
            ).where(*usage_where(scope))
        )
    ).one()
    runs = await _statuses(
        db,
        runs_query(scope, AgentRun.status, func.count(AgentRun.id)).group_by(
            AgentRun.status
        ),
    )
    jobs = await _statuses(
        db,
        jobs_query(scope, ProjectJob.status, func.count(ProjectJob.id)).group_by(
            ProjectJob.status
        ),
    )
    input_, output, cache_write, cache_read, cost, sessions, estimated = tokens
    return {
        "start": scope.start.isoformat(),
        "end": scope.end.isoformat(),
        "tokens": {
            "input": int(input_),
            "output": int(output),
            "cache_write": int(cache_write),
            "cache_read": int(cache_read),
            "total": int(input_ + output + cache_write + cache_read),
        },
        "cost_usd": usd(cost),
        "sessions": int(sessions),
        "estimated": bool(estimated),
        "budget": await _budget(db, scope.org_id),
        "active": {
            "day": await _active(db, scope, 1),
            "week": await _active(db, scope, 7),
            "month": await _active(db, scope, 30),
        },
        "runs": _ended(runs),
        "jobs": _ended(jobs),
    }


async def daily(db: AsyncSession, scope: Scope) -> list[dict]:
    """Tokens and cost per day and provider, oldest first."""
    day = day_of(UsageRecord.created_at, dialect_of(db))
    rows = await db.execute(
        select(
            day,
            UsageRecord.provider,
            func.sum(TOKENS),
            func.sum(UsageRecord.cost_micro_usd),
        )
        .where(*usage_where(scope))
        .group_by(day, UsageRecord.provider)
        .order_by(day, UsageRecord.provider)
    )
    return [
        {
            "day": str(when),
            "provider": provider,
            "tokens": int(tokens or 0),
            "cost_usd": usd(cost),
        }
        for when, provider, tokens, cost in rows
    ]


async def names_of(db: AsyncSession, ids: set[str]) -> dict[str, User]:
    if not ids:
        return {}
    users = await db.scalars(select(User).where(User.id.in_(ids)))
    return {user.id: user for user in users}


async def people(db: AsyncSession, scope: Scope) -> list[dict]:
    """One row per person: runs, jobs, tokens, cost, engines, last seen.

    The organization's members come in even without activity; a deleted
    account's activity comes as one row with no name.
    """
    rows: dict[str | None, dict] = {}

    def row(user_id: str | None) -> dict:
        return rows.setdefault(
            user_id,
            {
                "runs": 0,
                "jobs": 0,
                "tokens": 0,
                "cost_micro": 0,
                "providers": set(),
                "models": set(),
            },
        )

    used = await db.execute(
        select(
            UsageRecord.user_id,
            UsageRecord.provider,
            UsageRecord.model,
            func.sum(TOKENS),
            func.sum(UsageRecord.cost_micro_usd),
        )
        .where(*usage_where(scope))
        .group_by(UsageRecord.user_id, UsageRecord.provider, UsageRecord.model)
    )
    for user_id, provider, model, tokens, cost in used:
        entry = row(user_id)
        entry["tokens"] += int(tokens or 0)
        entry["cost_micro"] += int(cost or 0)
        if provider:
            entry["providers"].add(provider)
        if model:
            entry["models"].add(model)
    for user_id, count in await db.execute(
        runs_query(scope, AgentRun.started_by, func.count(AgentRun.id)).group_by(
            AgentRun.started_by
        )
    ):
        row(user_id)["runs"] = int(count)
    for user_id, count in await db.execute(
        jobs_query(scope, ProjectJob.started_by, func.count(ProjectJob.id)).group_by(
            ProjectJob.started_by
        )
    ):
        row(user_id)["jobs"] = int(count)
    if scope.org_id:
        members = select(OrgMember.user_id).where(
            OrgMember.org_id == scope.org_id, *person_where(scope, OrgMember.user_id)
        )
        for (user_id,) in await db.execute(members):
            row(user_id)  # a member without activity still has a row
    seen = dict(
        (
            await db.execute(
                select(PresenceDay.user_id, func.max(PresenceDay.last_seen_at))
                .where(PresenceDay.user_id.in_([u for u in rows if u]))
                .where(*_presence_where(scope))
                .group_by(PresenceDay.user_id)
            )
        ).all()
    )
    names = await names_of(db, {u for u in rows if u})
    table = []
    for user_id, entry in rows.items():
        user = names.get(user_id) if user_id else None
        last = seen.get(user_id)
        table.append(
            {
                "user_id": user_id,
                "name": user.display_name if user else None,
                "email": user.email if user else None,
                "runs": entry["runs"],
                "jobs": entry["jobs"],
                "tokens": entry["tokens"],
                "cost_usd": usd(entry["cost_micro"]),
                "providers": sorted(entry["providers"]),
                "models": sorted(entry["models"]),
                "last_seen_at": aware(last).isoformat() if last else None,
            }
        )
    table.sort(key=lambda r: (-r["cost_usd"], -r["tokens"], r["name"] or "￿"))
    return table[:MAX_PEOPLE]


async def is_person_of(db: AsyncSession, org_id: str | None, user_id: str) -> bool:
    """Whether the person is (or was, by their presence) in the scope."""
    if await db.get(User, user_id) is None:
        return False
    if org_id is None:
        return True
    member = await db.scalar(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id, OrgMember.user_id == user_id
        )
    )
    if member is not None:
        return True
    was = await db.scalar(
        select(PresenceDay.id)
        .where(PresenceDay.org_id == org_id, PresenceDay.user_id == user_id)
        .limit(1)
    )
    return was is not None


async def timeline(db: AsyncSession, scope: Scope) -> list[dict]:
    """One person's sign-ins, runs, jobs and audited actions, newest first."""
    assert scope.user_id, "a timeline is one person's"
    events: list[dict] = []
    audit = select(AuditLog.created_at, AuditLog.action).where(
        AuditLog.user_id == scope.user_id,
        AuditLog.created_at >= scope.since,
        AuditLog.created_at < scope.until,
    )
    if scope.org_id:
        audit = audit.where(AuditLog.org_id == scope.org_id)
    for at, action in await db.execute(
        audit.order_by(AuditLog.created_at.desc()).limit(MAX_TIMELINE)
    ):
        kind = "sign_in" if action.startswith(SIGN_IN_PREFIX) else "audit"
        events.append({"at": at, "kind": kind, "what": action})
    runs = runs_query(
        scope,
        AgentRun.started_at,
        AgentRun.phase,
        AgentRun.status,
        AgentRun.provider,
        AgentRun.model,
        Project.name,
    )
    for at, phase, status, provider, model, project in await db.execute(
        runs.order_by(AgentRun.started_at.desc()).limit(MAX_TIMELINE)
    ):
        events.append(
            {
                "at": at,
                "kind": "run",
                "what": phase,
                "status": status,
                "project": project,
                "provider": provider,
                "model": model,
            }
        )
    jobs = jobs_query(
        scope,
        ProjectJob.started_at,
        ProjectJob.feature,
        ProjectJob.status,
        Project.name,
    )
    for at, feature, status, project in await db.execute(
        jobs.order_by(ProjectJob.started_at.desc()).limit(MAX_TIMELINE)
    ):
        events.append(
            {
                "at": at,
                "kind": "job",
                "what": feature,
                "status": status,
                "project": project,
            }
        )
    events.sort(key=lambda event: aware(event["at"]), reverse=True)
    return [{**e, "at": aware(e["at"]).isoformat()} for e in events[:MAX_TIMELINE]]


def aware(moment: datetime) -> datetime:
    """SQLite gives the stored UTC moments back without their zone."""
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


async def models(db: AsyncSession, scope: Scope) -> dict:
    """Each provider and model: tokens, cost, runs and how they ended; per phase too."""
    rows = await db.execute(
        select(
            UsageRecord.provider,
            UsageRecord.model,
            UsageRecord.phase,
            UsageRecord.run_id,
            AgentRun.status,
            func.count(UsageRecord.id),
            func.sum(TOKENS),
            func.sum(UsageRecord.cost_micro_usd),
        )
        .outerjoin(AgentRun, AgentRun.id == UsageRecord.run_id)
        .where(*usage_where(scope))
        .group_by(
            UsageRecord.provider,
            UsageRecord.model,
            UsageRecord.phase,
            UsageRecord.run_id,
            AgentRun.status,
        )
    )
    engines: dict[tuple, dict] = {}
    phases: dict[tuple, dict] = {}

    def tally(table: dict, key: tuple) -> dict:
        return table.setdefault(
            key,
            {"sessions": 0, "tokens": 0, "cost": 0, "runs": {}},
        )

    for provider, model, phase, run_id, status, sessions, tokens, cost in rows:
        for entry in (
            tally(engines, (provider, model)),
            tally(phases, (provider, model, phase)),
        ):
            entry["sessions"] += int(sessions)
            entry["tokens"] += int(tokens or 0)
            entry["cost"] += int(cost or 0)
            if run_id:
                entry["runs"][run_id] = status

    def shape(entry: dict) -> dict:
        ended = list(entry["runs"].values())
        succeeded = ended.count("succeeded")
        failed = ended.count("failed")
        runs = len(ended)
        return {
            "sessions": entry["sessions"],
            "tokens": entry["tokens"],
            "cost_usd": usd(entry["cost"]),
            "runs": runs,
            "succeeded": succeeded,
            "failed": failed,
            "success_rate": rate(succeeded, failed),
            "cost_per_run_usd": usd(entry["cost"] // runs) if runs else None,
        }

    return {
        "models": sorted(
            ({"provider": p, "model": m, **shape(e)} for (p, m), e in engines.items()),
            key=lambda r: (-r["cost_usd"], r["provider"], r["model"]),
        ),
        "phases": sorted(
            (
                {"provider": p, "model": m, "phase": ph, **shape(e)}
                for (p, m, ph), e in phases.items()
            ),
            key=lambda r: (r["phase"], -r["cost_usd"], r["provider"], r["model"]),
        ),
    }


async def projects(db: AsyncSession, scope: Scope) -> list[dict]:
    """Tokens and cost per project, split by phase, with its runs."""
    table: dict[str | None, dict] = {}
    rows = await db.execute(
        select(
            UsageRecord.project_id,
            Project.name,
            UsageRecord.phase,
            func.sum(TOKENS),
            func.sum(UsageRecord.cost_micro_usd),
        )
        .outerjoin(Project, Project.id == UsageRecord.project_id)
        .where(*usage_where(scope))
        .group_by(UsageRecord.project_id, Project.name, UsageRecord.phase)
    )
    for project_id, name, phase, tokens, cost in rows:
        entry = table.setdefault(
            project_id,
            {"project_id": project_id, "name": name, "tokens": 0, "cost": 0, "runs": 0},
        )
        entry["tokens"] += int(tokens or 0)
        entry["cost"] += int(cost or 0)
        entry.setdefault("phases", []).append(
            {"phase": phase, "tokens": int(tokens or 0), "cost_usd": usd(cost)}
        )
    for project_id, count in await db.execute(
        runs_query(scope, Project.id, func.count(AgentRun.id)).group_by(Project.id)
    ):
        if project_id in table:
            table[project_id]["runs"] = int(count)
    shaped = [
        {
            "project_id": e["project_id"],
            "name": e["name"],
            "tokens": e["tokens"],
            "cost_usd": usd(e["cost"]),
            "runs": e["runs"],
            "phases": sorted(e["phases"], key=lambda p: -p["cost_usd"]),
        }
        for e in table.values()
    ]
    return sorted(shaped, key=lambda r: (-r["cost_usd"], r["name"] or ""))


async def pages(db: AsyncSession, scope: Scope) -> dict:
    """The pages opened, how often and by how many people, per app."""
    where = [
        PageVisit.day >= scope.start,
        PageVisit.day <= scope.end,
        *person_where(scope, PageVisit.user_id),
    ]
    enabled = None
    if scope.org_id:
        where.append(PageVisit.org_id == scope.org_id)
        enabled = (await usage_settings.of_org(db, scope.org_id)).page_activity
    rows = await db.execute(
        select(
            PageVisit.client,
            PageVisit.page,
            func.sum(PageVisit.count),
            func.count(func.distinct(PageVisit.user_id)),
        )
        .where(*where)
        .group_by(PageVisit.client, PageVisit.page)
    )
    table = [
        {"client": client, "page": page, "opens": int(opens), "people": int(people)}
        for client, page, opens, people in rows
    ]
    table.sort(key=lambda r: (-r["opens"], r["client"], r["page"]))
    return {"enabled": enabled, "pages": table}
