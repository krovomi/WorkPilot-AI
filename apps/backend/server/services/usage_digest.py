"""The usage report of one organization for one period, as figures.

The daily report covers one UTC day (the one before the report goes out) and
sets each figure beside the day before and the average of the seven days
before it; a weekly or monthly report covers a week or a month and sets each
figure beside the period before. Everything comes from the views of the Usage
tab (``usage_report.py``, ``usage_delivery.py``): totals, names and causes,
never a prompt, code or an error text. With ``names`` off, the people are
left unnamed (``name`` None) and the reader sees only their rank.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from server.db.models import Organization, OrgMember, PresenceDay
from server.services import usage_delivery, usage_report
from server.services.usage_report import Scope
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

Kind = Literal["daily", "weekly", "monthly"]
KINDS: tuple[Kind, ...] = ("daily", "weekly", "monthly")
#: People and engines a report lists.
TOP_PEOPLE = 5
TOP_ENGINES = 10
#: Shares of the monthly budget that raise an alert.
BUDGET_ALERTS = (100, 80)

FIGURES = (
    "tokens",
    "cost_usd",
    "active",
    "new_members",
    "runs",
    "succeeded",
    "failed",
    "success_rate",
    "merged",
    "cost_per_task_usd",
)


@dataclass(frozen=True)
class Period:
    kind: Kind
    start: date
    end: date

    def before(self) -> Period:
        """The period of the same kind just before this one."""
        if self.kind == "monthly":
            end = self.start - timedelta(days=1)
            return Period(self.kind, end.replace(day=1), end)
        length = self.end - self.start + timedelta(days=1)
        return Period(self.kind, self.start - length, self.start - timedelta(days=1))


def period_of(kind: Kind, today: date) -> Period:
    """The period a report sent on ``today`` covers: the last full one."""
    if kind == "daily":
        day = today - timedelta(days=1)
        return Period(kind, day, day)
    if kind == "weekly":
        monday = today - timedelta(days=today.weekday())
        return Period(kind, monday - timedelta(days=7), monday - timedelta(days=1))
    last = today.replace(day=1) - timedelta(days=1)
    return Period(kind, last.replace(day=1), last)


def period_containing(kind: Kind, day: date) -> Period:
    """The period of ``kind`` that holds ``day``."""
    if kind == "daily":
        return Period(kind, day, day)
    if kind == "weekly":
        monday = day - timedelta(days=day.weekday())
        return Period(kind, monday, monday + timedelta(days=6))
    first = day.replace(day=1)
    following = (first + timedelta(days=32)).replace(day=1)
    return Period(kind, first, following - timedelta(days=1))


async def _active(db: AsyncSession, scope: Scope) -> int:
    count = await db.scalar(
        select(func.count(func.distinct(PresenceDay.user_id))).where(
            PresenceDay.org_id == scope.org_id,
            PresenceDay.day >= scope.start,
            PresenceDay.day <= scope.end,
            PresenceDay.user_id.is_not(None),
        )
    )
    return int(count or 0)


async def _joined(db: AsyncSession, scope: Scope) -> int:
    count = await db.scalar(
        select(func.count(OrgMember.user_id)).where(
            OrgMember.org_id == scope.org_id,
            OrgMember.created_at >= scope.since,
            OrgMember.created_at < scope.until,
        )
    )
    return int(count or 0)


async def figures(db: AsyncSession, scope: Scope) -> dict:
    """The compared figures of one period."""
    summary = await usage_report.summary(db, scope)
    delivered = (await usage_delivery.delivery(db, scope))["delivered"]
    runs = summary["runs"]
    return {
        "tokens": summary["tokens"]["total"],
        "cost_usd": summary["cost_usd"],
        "active": await _active(db, scope),
        "new_members": await _joined(db, scope),
        "runs": runs["total"],
        "succeeded": runs["succeeded"],
        "failed": runs["failed"],
        "success_rate": runs["success_rate"],
        "merged": delivered["tasks"],
        "cost_per_task_usd": delivered["cost_per_task_usd"],
    }


def _mean(values: list[float | int | None]) -> float | None:
    known = [v for v in values if v is not None]
    return round(sum(known) / len(known), 4) if known else None


async def _average(db: AsyncSession, org_id: str, day: date) -> dict:
    """Each figure's mean over the seven days before ``day``."""
    week = [
        await figures(db, Scope(org_id, d, d))
        for d in (day - timedelta(days=n) for n in range(1, 8))
    ]
    return {name: _mean([f[name] for f in week]) for name in FIGURES}


def _alerts(budget: dict | None) -> list[dict]:
    percent = budget and budget.get("percent")
    if not percent:
        return []
    for threshold in BUDGET_ALERTS:
        if percent >= threshold:
            return [{"kind": "budget", "threshold": threshold, "percent": percent}]
    return []


async def digest(
    db: AsyncSession, org_id: str, period: Period, *, names: bool = True
) -> dict:
    """The report of ``period`` for the organization."""
    scope = Scope(org_id, period.start, period.end)
    now = await figures(db, scope)
    before = period.before()
    previous = await figures(db, Scope(org_id, before.start, before.end))
    average = (
        await _average(db, org_id, period.start) if period.kind == "daily" else None
    )
    summary = await usage_report.summary(db, scope)
    people = [p for p in await usage_report.people(db, scope) if p["tokens"]]
    engines = (await usage_report.models(db, scope))["models"][:TOP_ENGINES]
    delivery = await usage_delivery.delivery(db, scope)
    moment = datetime.combine(period.end + timedelta(days=1), time.min, UTC)
    dormant = (await usage_delivery.presence(db, org_id, moment))["dormant"]
    org = await db.get(Organization, org_id)
    return {
        "kind": period.kind,
        "organization": org.name if org else None,
        "start": period.start.isoformat(),
        "end": period.end.isoformat(),
        "names": names,
        "figures": {
            name: {
                "value": now[name],
                "previous": previous[name],
                "average": average[name] if average else None,
            }
            for name in FIGURES
        },
        "budget": summary["budget"],
        "dormant": len(dormant),
        "top": [
            {
                "name": (p["name"] or p["email"]) if names and p["user_id"] else None,
                "tokens": p["tokens"],
                "cost_usd": p["cost_usd"],
            }
            for p in people[:TOP_PEOPLE]
        ],
        "engines": [
            {
                "provider": e["provider"],
                "model": e["model"],
                "tokens": e["tokens"],
                "cost_usd": e["cost_usd"],
                "runs": e["runs"],
            }
            for e in engines
        ],
        "failures": delivery["failures"],
        "alerts": _alerts(summary["budget"]),
    }
