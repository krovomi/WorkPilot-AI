"""Sending each organization's usage report when it is due, once.

:func:`start` runs :func:`tick` every minute in the server's event loop. For
each active organization, a report is due once its hour has passed, in its
time zone, on one of its days (``services/report_settings.py``): the daily
report each chosen day, the weekly one on Mondays, the monthly one on the
first of the month. A due report is first claimed by inserting its row in
``usage_report_sends``, whose unique key on (organization, kind, period)
lets only one claim through: never two sends of the same report, even after
a restart. A server that was down at the hour sends it when it comes back the
same day.

Each tick also raises the budget alerts this month's use has reached
(``services/usage_budgets.py``), sent to the same recipients.

Without SMTP, nothing is sent and the claim says ``no_smtp``; the report stays
readable in the app (``GET /admin/usage/report``). Each claim is audited
(``usage.report.sent``) with its kind, period, outcome and how many addresses
it went to, never which.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime

from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import Organization, OrgMember, Role, UsageReportSend, User
from server.services import (
    email,
    report_settings,
    usage_budgets,
    usage_digest,
    usage_digest_mail,
)
from server.services.audit import record
from server.services.report_settings import ReportSettings
from server.services.usage_digest import Kind, Period
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 60.0
SENT = "usage.report.sent"

_task: asyncio.Task | None = None


async def readers(db: AsyncSession, org_id: str) -> list[str]:
    """The addresses of the active members whose role reads usage."""
    roles = await db.scalars(
        select(Role).where(or_(Role.org_id.is_(None), Role.org_id == org_id))
    )
    reading = [r.id for r in roles if "usage.read" in (r.permissions or [])]
    emails = await db.scalars(
        select(User.email)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(
            OrgMember.org_id == org_id,
            OrgMember.role_id.in_(reading),
            User.is_active.is_(True),
        )
        .order_by(User.email)
    )
    return [e.lower() for e in emails]


async def member_addresses(db: AsyncSession, org_id: str) -> set[str]:
    emails = await db.scalars(
        select(User.email)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(OrgMember.org_id == org_id)
    )
    return {e.lower() for e in emails}


async def recipients_of(
    db: AsyncSession, org_id: str, settings: ReportSettings
) -> list[str]:
    """The addresses the report goes to: the chosen ones, or its readers."""
    return list(settings.recipients) or await readers(db, org_id)


def due(settings: ReportSettings, local: datetime) -> list[Period]:
    """The reports due at ``local`` (the organization's own time)."""
    if not settings.enabled or local.time() < settings.at:
        return []
    today = local.date()
    kinds: list[Kind] = []
    if today.weekday() in settings.days:
        kinds.append("daily")
    if settings.weekly and today.weekday() == 0:
        kinds.append("weekly")
    if settings.monthly and today.day == 1:
        kinds.append("monthly")
    return [usage_digest.period_of(kind, today) for kind in kinds]


async def deliver(
    db: AsyncSession, org_id: str, settings: ReportSettings, period: Period
) -> tuple[str, int]:
    """Build the report of ``period`` and send it; its outcome and how many
    addresses it went to."""
    if not get_settings().email_enabled:
        return "no_smtp", 0
    to = await recipients_of(db, org_id, settings)
    if not to:
        return "no_recipient", 0
    report = await usage_digest.digest(db, org_id, period, names=settings.names)
    msg = usage_digest_mail.message(
        report, settings.language, get_settings().smtp_from, to
    )
    try:
        await email.send_message(msg)
    except email.EmailError:
        return "failed", len(to)
    return "sent", len(to)


async def _claim(db: AsyncSession, org_id: str, period: Period) -> bool:
    db.add(UsageReportSend(org_id=org_id, kind=period.kind, period=period.start))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return False
    return True


async def _settle(
    db: AsyncSession, org_id: str, period: Period, status: str, count: int
) -> None:
    row = await db.scalar(
        select(UsageReportSend).where(
            UsageReportSend.org_id == org_id,
            UsageReportSend.kind == period.kind,
            UsageReportSend.period == period.start,
        )
    )
    if row is not None:
        row.status = status
        row.recipients = count
    await record(
        db,
        action=SENT,
        actor_id=None,
        org_id=org_id,
        payload={
            "kind": period.kind,
            "period": period.start.isoformat(),
            "status": status,
            "recipients": count,
        },
    )
    await db.commit()


async def tick(now: datetime | None = None) -> list[dict]:
    """Send every report due now; what was claimed, and how it ended."""
    now = now or datetime.now(UTC)
    done: list[dict] = []
    factory = get_session_factory()
    async with factory() as db:
        orgs = (
            await db.execute(
                select(Organization.id, Organization.name, Organization.settings).where(
                    Organization.is_active.is_(True)
                )
            )
        ).all()
        for org_id, name, raw in orgs:
            settings = report_settings.of(raw)
            for period in due(settings, now.astimezone(settings.zone)):
                if not await _claim(db, org_id, period):
                    continue
                status, count = await deliver(db, org_id, settings, period)
                await _settle(db, org_id, period, status, count)
                done.append({"org_id": org_id, "kind": period.kind, "status": status})
            to = await recipients_of(db, org_id, settings)
            await usage_budgets.check(db, org_id, name, settings, to, now)
    return done


async def last_sends(db: AsyncSession, org_id: str, limit: int = 10) -> list[dict]:
    rows = await db.scalars(
        select(UsageReportSend)
        .where(UsageReportSend.org_id == org_id)
        .order_by(UsageReportSend.created_at.desc())
        .limit(limit)
    )
    return [
        {
            "kind": r.kind,
            "period": r.period.isoformat(),
            "status": r.status,
            "recipients": r.recipients,
            "at": usage_digest_at(r.created_at),
        }
        for r in rows
    ]


def usage_digest_at(moment: datetime) -> str:
    return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).isoformat()


async def _loop(ready: Callable[[], Awaitable[None]] | None, interval: float) -> None:
    while True:
        try:
            if ready is not None:
                await ready()
            await tick()
        except SQLAlchemyError as e:
            logger.warning("Usage report tick failed: %s", type(e).__name__)
        await asyncio.sleep(interval)


def start(
    ready: Callable[[], Awaitable[None]] | None = None,
    interval: float = INTERVAL_SECONDS,
) -> asyncio.Task:
    """Check every minute for the reports due."""
    global _task
    if _task is not None and not _task.done():
        return _task
    _task = asyncio.get_running_loop().create_task(_loop(ready, interval))
    return _task


async def stop() -> None:
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


def today_in(settings: ReportSettings, now: datetime | None = None) -> date:
    """The organization's own date now."""
    return (now or datetime.now(UTC)).astimezone(settings.zone).date()
