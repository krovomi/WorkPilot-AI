"""Erasing usage data older than its organization keeps it.

What the usage views read is personal data (who used the server, how much,
which pages): each organization keeps it as long as its usage settings say
(``services/usage_settings.py``: token use and presence 365 days, page counts
183, unless the organization or the server's ``WORKPILOT_USAGE_RETENTION_DAYS``
and ``WORKPILOT_PAGE_ACTIVITY_RETENTION_DAYS`` set another), then erases it.
:func:`start` runs :func:`sweep` every :data:`INTERVAL_SECONDS` in the
server's event loop while server mode is mounted. A failed sweep is logged by
its type and tried again at the next turn.

Erased here: tokens per run and job (``usage_records``), presence days
(``presence_days``) and page counts (``page_visits``). The audit log keeps its
own history.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from server.db.engine import get_session_factory
from server.db.models import Organization, PageVisit, PresenceDay, UsageRecord
from server.services.usage_settings import UsageSettings, of
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

logger = logging.getLogger(__name__)

#: Every hour: a day's worth of rows leaves within the hour it expires.
INTERVAL_SECONDS = 3600.0

_task: asyncio.Task | None = None


def retention() -> timedelta:
    """The server's own retention of token use and presence."""
    return UsageSettings().usage_retention()


async def sweep(now: datetime | None = None) -> dict[str, int]:
    """Erase what is older than each organization keeps; the rows erased."""
    now = now or datetime.now(UTC)
    erased = {"usage_records": 0, "presence_days": 0, "page_visits": 0}
    async with get_session_factory()() as db:
        own = {
            org_id: settings
            for org_id, raw in (
                await db.execute(select(Organization.id, Organization.settings))
            ).all()
            if (settings := of(raw)).usage_retention_days
            or settings.page_activity_retention_days
        }
        server = UsageSettings()
        for org_id, settings in [*own.items(), (None, server)]:
            usage_cutoff = now - settings.usage_retention()
            page_cutoff = now - settings.page_activity_retention()
            erased["usage_records"] += await _delete(
                db, UsageRecord, UsageRecord.created_at < usage_cutoff, org_id, own
            )
            erased["presence_days"] += await _delete(
                db, PresenceDay, PresenceDay.day < usage_cutoff.date(), org_id, own
            )
            erased["page_visits"] += await _delete(
                db, PageVisit, PageVisit.day < page_cutoff.date(), org_id, own
            )
        await db.commit()
    return erased


async def _delete(
    db: AsyncSession,
    model: type[UsageRecord] | type[PresenceDay] | type[PageVisit],
    older: ColumnElement[bool],
    org_id: str | None,
    own: dict[str, UsageSettings],
) -> int:
    """Delete one organization's old rows, or (``org_id`` None) those of every
    organization that keeps the server's retention, and of none."""
    if org_id is not None:
        where = model.org_id == org_id
    else:
        where = or_(model.org_id.is_(None), model.org_id.not_in(list(own)))
    result = await db.execute(delete(model).where(older, where))
    return result.rowcount or 0


async def _loop(ready: Callable[[], Awaitable[None]] | None, interval: float) -> None:
    while True:
        try:
            if ready is not None:
                await ready()
            await sweep()
        except SQLAlchemyError as e:
            logger.warning("Usage retention sweep failed: %s", type(e).__name__)
        await asyncio.sleep(interval)


def start(
    ready: Callable[[], Awaitable[None]] | None = None,
    interval: float = INTERVAL_SECONDS,
) -> asyncio.Task:
    """Run the sweep periodically in this event loop."""
    global _task
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
