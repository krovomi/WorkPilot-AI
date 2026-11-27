"""Monthly token budgets per person, group or project, and their alerts.

An organization already has one monthly budget (``org_quotas``); here it sets
more, each on one person, one group (its members' tokens in the organization)
or one project, counted from the first of the month (UTC) like the
organization's. A budget with ``block`` refuses new runs and jobs of what it
covers once it is spent (:func:`refuse_spent`, called with the organization's
own check in ``services/quotas.py``); without it, it only alerts.

Each budget, the organization's own included, raises one alert per month at
80 % and one at 100 % (:func:`check`, from the usage report's tick). The
alert is claimed by its row in ``usage_budget_alerts``, unique on budget,
month and threshold, then emailed to the usage report's recipients and
audited (``usage.budget.alert``) with how many addresses it went to. The
email names a person only while the organization's report names people.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from email.message import EmailMessage
from typing import Literal

from fastapi import HTTPException
from server.config import get_settings
from server.db.models import (
    GroupMember,
    OrgMember,
    OrgQuota,
    Project,
    UsageBudget,
    UsageBudgetAlert,
    UsageRecord,
    User,
    UserGroup,
)
from server.services import email
from server.services.audit import record
from server.services.report_settings import ReportSettings
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

Scope = Literal["person", "group", "project"]
SCOPES: tuple[Scope, ...] = ("person", "group", "project")
THRESHOLDS = (100, 80)
MAX_TOKENS = 10**12
ALERT = "usage.budget.alert"
#: The budget key of the organization's own monthly budget.
ORG = "org"

_TOKENS = (
    UsageRecord.input_tokens
    + UsageRecord.output_tokens
    + UsageRecord.cache_write_tokens
    + UsageRecord.cache_read_tokens
)


@dataclass(frozen=True)
class Status:
    """A budget with what it used this month."""

    key: str
    scope: str
    target_id: str | None
    name: str | None
    monthly_tokens: int
    block: bool
    used: int

    @property
    def percent(self) -> float:
        return round(100 * self.used / self.monthly_tokens, 1)

    def as_dict(self) -> dict:
        return {
            "id": None if self.key == ORG else self.key,
            "scope": self.scope,
            "target_id": self.target_id,
            "name": self.name,
            "monthly_tokens": self.monthly_tokens,
            "block": self.block,
            "used": self.used,
            "percent": self.percent,
        }


def month_of(now: datetime) -> date:
    return now.astimezone(UTC).date().replace(day=1)


def _since(now: datetime) -> datetime:
    return datetime.combine(month_of(now), datetime.min.time(), UTC)


async def _used(
    db: AsyncSession, org_id: str, scope: str, target_id: str, since: datetime
) -> int:
    query = select(func.coalesce(func.sum(_TOKENS), 0)).where(
        UsageRecord.org_id == org_id, UsageRecord.created_at >= since
    )
    if scope == "person":
        query = query.where(UsageRecord.user_id == target_id)
    elif scope == "project":
        query = query.where(UsageRecord.project_id == target_id)
    else:
        members = select(GroupMember.user_id).where(GroupMember.group_id == target_id)
        query = query.where(UsageRecord.user_id.in_(members))
    return int(await db.scalar(query) or 0)


async def target_name(
    db: AsyncSession, org_id: str, scope: str, target_id: str
) -> str | None:
    """The target's name within the organization; None when it is not there."""
    if scope == "person":
        row = (
            await db.execute(
                select(User.display_name, User.email)
                .join(OrgMember, OrgMember.user_id == User.id)
                .where(OrgMember.org_id == org_id, User.id == target_id)
            )
        ).first()
        return (row[0] or row[1]) if row else None
    model = UserGroup if scope == "group" else Project
    return await db.scalar(
        select(model.name).where(model.id == target_id, model.org_id == org_id)
    )


async def statuses(
    db: AsyncSession, org_id: str, now: datetime | None = None
) -> list[Status]:
    """The organization's budgets with this month's use: its own first, when
    set. A budget whose target is gone from the organization is dropped."""
    since = _since(now or datetime.now(UTC))
    found: list[Status] = []
    own = await db.scalar(
        select(OrgQuota.monthly_token_budget).where(OrgQuota.org_id == org_id)
    )
    if own:
        hard = await db.scalar(
            select(OrgQuota.enforce_hard_stop).where(OrgQuota.org_id == org_id)
        )
        used = await db.scalar(
            select(func.coalesce(func.sum(_TOKENS), 0)).where(
                UsageRecord.org_id == org_id, UsageRecord.created_at >= since
            )
        )
        found.append(Status(ORG, ORG, None, None, own, bool(hard), int(used or 0)))
    gone: list[str] = []
    budgets = await db.scalars(
        select(UsageBudget)
        .where(UsageBudget.org_id == org_id)
        .order_by(UsageBudget.scope, UsageBudget.target_id)
    )
    for budget in budgets:
        name = await target_name(db, org_id, budget.scope, budget.target_id)
        if name is None:
            gone.append(budget.id)
            continue
        used = await _used(db, org_id, budget.scope, budget.target_id, since)
        found.append(
            Status(
                budget.id,
                budget.scope,
                budget.target_id,
                name,
                budget.monthly_tokens,
                budget.block,
                used,
            )
        )
    if gone:
        await db.execute(delete(UsageBudget).where(UsageBudget.id.in_(gone)))
        await db.commit()
    return found


async def refuse_spent(
    db: AsyncSession, org_id: str, user_id: str | None, project_id: str | None
) -> None:
    """Refuse (402) a run or job whose person, group or project has spent a
    blocking budget this month."""
    covers: list[tuple[str, str]] = []
    if user_id:
        covers.append(("person", user_id))
        groups = await db.scalars(
            select(GroupMember.group_id).where(GroupMember.user_id == user_id)
        )
        covers.extend(("group", g) for g in groups)
    if project_id:
        covers.append(("project", project_id))
    if not covers:
        return
    since = _since(datetime.now(UTC))
    budgets = await db.scalars(
        select(UsageBudget).where(
            UsageBudget.org_id == org_id, UsageBudget.block.is_(True)
        )
    )
    for budget in budgets:
        if (budget.scope, budget.target_id) not in covers:
            continue
        used = await _used(db, org_id, budget.scope, budget.target_id, since)
        if used >= budget.monthly_tokens:
            raise HTTPException(
                status_code=402,
                detail=(
                    f"The monthly token budget of this {budget.scope} is spent. "
                    "Runs are blocked until it is raised or the month rolls over."
                ),
            )


def _threshold(percent: float) -> int | None:
    return next((t for t in THRESHOLDS if percent >= t), None)


WORDS = {
    "fr": {
        "subject": "WorkPilot : {percent} % du budget mensuel de tokens de {target}",
        "body": (
            "{target} a utilisé {used} tokens sur {limit} ce mois-ci ({percent} %), "
            "au-delà du seuil de {threshold} %.{blocked}\n\n"
            "Les budgets se règlent dans Administration, Usage, Budgets."
        ),
        "blocked": " Les nouveaux runs sont refusés jusqu'au mois prochain.",
        "org": "l'organisation {org}",
        "person": "une personne",
        "group": "le groupe {name}",
        "project": "le projet {name}",
    },
    "en": {
        "subject": "WorkPilot: {percent} % of {target}'s monthly token budget",
        "body": (
            "{target} used {used} tokens of {limit} this month ({percent} %), "
            "past the {threshold} % threshold.{blocked}\n\n"
            "Budgets are set in Administration, Usage, Budgets."
        ),
        "blocked": " New runs are refused until next month.",
        "org": "the organization {org}",
        "person": "a person",
        "group": "the group {name}",
        "project": "the project {name}",
    },
}


def _target(status: Status, words: dict, org: str, names: bool) -> str:
    if status.scope == ORG:
        return words["org"].format(org=org)
    if status.scope == "person":
        return status.name if names and status.name else words["person"]
    return words[status.scope].format(name=status.name)


def alert_message(
    status: Status,
    threshold: int,
    settings: ReportSettings,
    org: str,
    sender: str,
    to: list[str],
) -> EmailMessage:
    """The alert email, in the report's language, as plain text."""
    words = WORDS[settings.language if settings.language in WORDS else "fr"]
    target = _target(status, words, org, settings.names)
    blocked = words["blocked"] if status.block and threshold == 100 else ""
    msg = EmailMessage()
    msg["Subject"] = words["subject"].format(percent=status.percent, target=target)
    msg["From"] = sender
    msg["To"] = ", ".join(to)
    msg.set_content(
        words["body"].format(
            target=target[:1].upper() + target[1:],
            used=f"{status.used:,}".replace(",", " "),
            limit=f"{status.monthly_tokens:,}".replace(",", " "),
            percent=status.percent,
            threshold=threshold,
            blocked=blocked,
        )
    )
    return msg


async def _claim(
    db: AsyncSession, org_id: str, status: Status, month: date, threshold: int
) -> str | None:
    """Insert the alert's row; its id, or None when it was already raised."""
    alert_id = str(uuid.uuid4())
    db.add(
        UsageBudgetAlert(
            id=alert_id,
            org_id=org_id,
            budget_key=status.key,
            scope=status.scope,
            month=month,
            threshold=threshold,
            percent=status.percent,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return None
    return alert_id


async def check(
    db: AsyncSession,
    org_id: str,
    org_name: str,
    settings: ReportSettings,
    to: list[str],
    now: datetime | None = None,
) -> list[dict]:
    """Raise each alert this month's use has reached; the alerts raised.

    Past 100 % at once, only the 100 % alert goes: the 80 % one is claimed
    with it so that it never follows."""
    now = now or datetime.now(UTC)
    month = month_of(now)
    raised: list[dict] = []
    for status in await statuses(db, org_id, now):
        threshold = _threshold(status.percent)
        if threshold is None:
            continue
        alert_id = await _claim(db, org_id, status, month, threshold)
        if alert_id is None:
            continue
        for lower in THRESHOLDS:
            if lower < threshold:
                await _claim(db, org_id, status, month, lower)
        count = 0
        if get_settings().email_enabled and to:
            msg = alert_message(
                status, threshold, settings, org_name, get_settings().smtp_from, to
            )
            try:
                await email.send_message(msg)
                count = len(to)
            except email.EmailError:
                count = 0
        await db.execute(
            update(UsageBudgetAlert)
            .where(UsageBudgetAlert.id == alert_id)
            .values(recipients=count)
        )
        await record(
            db,
            action=ALERT,
            actor_id=None,
            org_id=org_id,
            payload={
                "scope": status.scope,
                "budget_id": None if status.key == ORG else status.key,
                "threshold": threshold,
                "percent": status.percent,
                "recipients": count,
            },
        )
        await db.commit()
        raised.append({"scope": status.scope, "threshold": threshold})
    return raised


async def last_alerts(db: AsyncSession, org_id: str, limit: int = 20) -> list[dict]:
    rows = await db.scalars(
        select(UsageBudgetAlert)
        .where(UsageBudgetAlert.org_id == org_id)
        .order_by(UsageBudgetAlert.created_at.desc())
        .limit(limit)
    )
    return [
        {
            "budget_id": None if r.budget_key == ORG else r.budget_key,
            "scope": r.scope,
            "month": r.month.isoformat(),
            "threshold": r.threshold,
            "percent": r.percent,
            "recipients": r.recipients,
        }
        for r in rows
    ]


async def drop_person(db: AsyncSession, user_id: str) -> int:
    """Remove every budget set on one person (an erased account)."""
    done = await db.execute(
        delete(UsageBudget).where(
            UsageBudget.scope == "person", UsageBudget.target_id == user_id
        )
    )
    return done.rowcount or 0
