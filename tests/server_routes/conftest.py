"""The ``world`` fixture: a fresh server-mode deployment per test."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from tests.server_routes.world import World, clean_environment, seed, server_env


@pytest.fixture(autouse=True)
def _server_settings(monkeypatch, tmp_path):
    from server import config as server_config
    from server import integration
    from server.db import engine as db_engine
    from server.ratelimit import limiter
    from server.services import project_jobs, run_manager

    for key in clean_environment():
        monkeypatch.delenv(key, raising=False)
    for key, value in server_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    server_config.reset_settings_cache()
    # Each test starts from nothing: no engine of an earlier database, no run
    # or job bookkeeping, the first request initializes the schema as a fresh
    # server does, and the login limit counts from zero.
    monkeypatch.setattr(db_engine, "_engine", None)
    monkeypatch.setattr(db_engine, "_session_factory", None)
    monkeypatch.setattr(integration, "_db_ready", False)
    monkeypatch.setattr(integration, "_db_init_lock", None)
    monkeypatch.setattr(run_manager, "_run_manager", None)
    monkeypatch.setattr(project_jobs, "_jobs", None)
    limiter.reset()
    yield
    server_config.reset_settings_cache()


@pytest_asyncio.fixture()
async def world(tmp_path) -> AsyncIterator[World]:
    from server.db import engine as db_engine

    built = await seed(tmp_path)
    try:
        yield built
    finally:
        await built.close()
        await db_engine.dispose_engine()
