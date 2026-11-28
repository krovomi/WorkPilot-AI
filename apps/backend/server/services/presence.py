"""Who used the server, and when: one row per person, organization and day.

The auth middleware calls :func:`touch` on each request it authenticated
(``server/integration.py``). The first request of a person in an organization
on a given day adds that day (``presence_days``); later ones move its
``last_seen_at``, at most every :data:`REFRESH`, so a busy session writes a
few rows an hour, not one per request.

That is all presence keeps: the day and the last moment of it, never the path
or the content of a request. From it come the people active per day, week and
month, those signed in now (seen within :data:`ONLINE_WINDOW`) and the accounts
lying dormant. A failed write is logged by its type and the request goes on:
presence never refuses anyone.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime, timedelta

from server.db.engine import get_session_factory
from server.db.models import PresenceDay
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

logger = logging.getLogger(__name__)

#: How often a person's last activity is written while they keep working.
REFRESH = timedelta(minutes=5)
#: Seen this recently = signed in now.
ONLINE_WINDOW = timedelta(minutes=10)
#: The throttle forgets everyone past this many entries (a restart does too).
MAX_REMEMBERED = 10_000

# (user, org) -> when its row was last written, by this process.
_written: dict[tuple[str, str | None], datetime] = {}


def _due(key: tuple[str, str | None], now: datetime) -> bool:
    last = _written.get(key)
    return last is None or last.date() != now.date() or now - last >= REFRESH


def forget() -> None:
    """Drop the throttle (tests, and a full memory)."""
    _written.clear()


async def touch(user_id: str, org_id: str | None, now: datetime | None = None) -> bool:
    """Note that ``user_id`` used the server in ``org_id`` now.

    True when a row was written; False when the throttle skipped it or the
    write failed.
    """
    now = now or datetime.now(UTC)
    key = (user_id, org_id)
    if not _due(key, now):
        return False
    if len(_written) >= MAX_REMEMBERED:
        forget()
    _written[key] = now
    try:
        await _write(user_id, org_id, now.date(), now)
    except SQLAlchemyError as e:
        # The type only: the statement could name the person.
        logger.warning("Presence not recorded: %s", type(e).__name__)
        _written.pop(key, None)
        return False
    return True


async def _write(user_id: str, org_id: str | None, day: date, now: datetime) -> None:
    async with get_session_factory()() as db:
        row = await db.scalar(
            select(PresenceDay).where(
                PresenceDay.user_id == user_id,
                PresenceDay.org_id.is_(None)
                if org_id is None
                else PresenceDay.org_id == org_id,
                PresenceDay.day == day,
            )
        )
        if row is not None:
            row.last_seen_at = now
            await db.commit()
            return
        db.add(PresenceDay(user_id=user_id, org_id=org_id, day=day, last_seen_at=now))
        try:
            await db.commit()
        except IntegrityError:
            # Another request of the same person added the day first.
            await db.rollback()
