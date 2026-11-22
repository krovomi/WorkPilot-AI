"""Erasing usage data older than the deployment keeps it.

What the usage views read is personal data (who used the server, how much):
it is kept :attr:`~server.config.ServerSettings.usage_retention_days` days
(``WORKPILOT_USAGE_RETENTION_DAYS``, 365 unless set, kept between
:data:`MIN_DAYS` and :data:`MAX_DAYS`), then erased. :func:`start` runs
:func:`sweep` every :data:`INTERVAL_SECONDS` in the server's event loop while
server mode is mounted. A failed sweep is logged by its type and tried again
at the next turn.

Erased here: tokens per run and job (``usage_records``) and presence days
(``presence_days``). The audit log keeps its own history.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import PresenceDay, UsageRecord
from sqlalchemy import delete
from sqlalchemy.exc import SQLAlchemyError

logger = logging.getLogger(__name__)

#: Every hour: a day's worth of rows leaves within the hour it expires.
INTERVAL_SECONDS = 3600.0
MIN_DAYS = 30
MAX_DAYS = 3650

_task: asyncio.Task | None = None


def retention() -> timedelta:
    days = get_settings().usage_retention_days
    return timedelta(days=min(max(days, MIN_DAYS), MAX_DAYS))


async def sweep(now: datetime | None = None) -> dict[str, int]:
    """Erase what is older than the retention; the rows erased, per table."""
    cutoff = (now or datetime.now(UTC)) - retention()
    async with get_session_factory()() as db:
        usage = await db.execute(
            delete(UsageRecord).where(UsageRecord.created_at < cutoff)
        )
        presence = await db.execute(
            delete(PresenceDay).where(PresenceDay.day < cutoff.date())
        )
        await db.commit()
    return {
        "usage_records": usage.rowcount or 0,
        "presence_days": presence.rowcount or 0,
    }


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
