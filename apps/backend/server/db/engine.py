"""Async SQLAlchemy engine + session factory for server mode.

The engine is created lazily from :func:`server.config.get_settings` so that
importing this module in local mode has zero side effects.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from server.config import get_settings
from server.db.models import Base
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

logger = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _foreign_keys_on(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


def enforce_sqlite_foreign_keys(engine: AsyncEngine) -> None:
    """Turn on SQLite's foreign keys on every connection of ``engine``.

    SQLite ignores them unless each connection asks (``PRAGMA foreign_keys``
    is off by default), so every ``ondelete`` of the models was a dead letter
    there: deleting a project left its specs, runs, jobs and members behind,
    and nothing stopped a row from pointing at a project that no longer
    existed (F175). PostgreSQL always enforces them.

    Only the application's engine: Alembic opens its own, and a batch
    migration that recreates a table must not cascade the drop of the old
    copy into its children.
    """
    event.listen(engine.sync_engine, "connect", _foreign_keys_on)


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        kwargs: dict = {"pool_pre_ping": True}
        if settings.database_url.startswith("sqlite"):
            # SQLite has no real pool; pre_ping is pointless and the file
            # may live in a directory that doesn't exist yet in dev.
            kwargs = {}
        _engine = create_async_engine(settings.database_url, **kwargs)
        if settings.database_url.startswith("sqlite"):
            enforce_sqlite_foreign_keys(_engine)
        logger.info(
            "Server DB engine created (%s)", settings.database_url.split("://")[0]
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding one session per request."""
    async with get_session_factory()() as session:
        yield session


async def init_db() -> None:
    """Create all tables if they don't exist, then seed what the app assumes.

    Used at startup as a safety net and by tests. Production deployments
    run ``alembic upgrade head`` first; ``create_all`` is a no-op then.

    The seed runs in both cases and is idempotent. It has to: a database
    created by ``create_all`` never executes revision ``0003``, so without this
    a fresh dev or test instance would come up with no built-in roles at all
    and every membership write would fail on a missing ``role_id``. Running it
    after Alembic too is what propagates a permission newly granted to a
    built-in role. The move of existing users into the default organization is
    not part of it after the first time: see
    :func:`server.db.seed.bootstrap_deployment`.
    """
    from server.db.seed import bootstrap_deployment

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(bootstrap_deployment)


async def dispose_engine() -> None:
    """Close the engine (shutdown / test teardown) and reset the cache."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
