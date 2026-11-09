"""A run the server holds can always be stopped, and a restart never leaves
one running forever.

Before: ``cancel_run`` answered False for a run still waiting for a slot (no
process yet), so Stop did nothing and the run started later anyway; and runs
left queued or running by a stopped server stayed that way, counted against
the organization's quota, so every new run got a 429.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "runs.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _fresh_db():
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    return db_engine.get_session_factory()


async def _spec(factory):
    from server.db.models import Organization, Project, SpecIndex, User
    from sqlalchemy import select

    async with factory() as db:
        # Who starts the runs below: a real row, as foreign keys are enforced.
        if await db.get(User, "u1") is None:
            db.add(User(id="u1", email="u1@test.invalid", display_name="U"))
        org_id = await db.scalar(
            select(Organization.id).where(Organization.slug == "default")
        )
        project = Project(
            org_id=org_id, name="P", repo_url="https://x/p.git", server_path="/tmp/p"
        )
        db.add(project)
        await db.flush()
        spec = SpecIndex(project_id=project.id, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        await db.refresh(spec)
        return project.id, spec


@pytest.mark.asyncio
async def test_settle_orphans_fails_runs_no_process_holds():
    from server.db.models import AgentRun
    from server.services.run_manager import INTERRUPTED, RunManager

    factory = await _fresh_db()
    _, spec = await _spec(factory)
    async with factory() as db:
        queued = AgentRun(spec_id=spec.id, phase="build", status="queued")
        running = AgentRun(spec_id=spec.id, phase="build", status="running")
        done = AgentRun(spec_id=spec.id, phase="build", status="succeeded")
        db.add_all([queued, running, done])
        await db.commit()
        ids = (queued.id, running.id, done.id)

    manager = RunManager()
    assert await manager.settle_orphans() == 2

    async with factory() as db:
        q, r, d = [await db.get(AgentRun, i) for i in ids]
        assert (q.status, r.status, d.status) == ("failed", "failed", "succeeded")
        assert q.error == INTERRUPTED and q.finished_at is not None


@pytest.mark.asyncio
async def test_settle_orphans_leaves_runs_this_process_tracks():
    from server.db.models import AgentRun
    from server.services.run_manager import RunManager

    factory = await _fresh_db()
    _, spec = await _spec(factory)
    async with factory() as db:
        mine = AgentRun(spec_id=spec.id, phase="build", status="queued")
        db.add(mine)
        await db.commit()
        run_id = mine.id

    manager = RunManager()
    manager._tracked.add(run_id)
    assert await manager.settle_orphans() == 0


@pytest.mark.asyncio
async def test_a_queued_run_can_be_cancelled_before_it_starts(monkeypatch):
    from server.db.models import AgentRun
    from server.services import run_manager as rm

    factory = await _fresh_db()
    project_id, spec = await _spec(factory)

    manager = rm.RunManager()
    gate = asyncio.Semaphore(0)  # no free slot: the run waits in the queue
    monkeypatch.setattr(manager, "_get_semaphore", lambda: gate)
    notified: list[str] = []

    async def _notify(*args):
        notified.append(args[-1])

    monkeypatch.setattr(manager, "_notify", _notify)

    async def _never(*_a, **_k):
        raise AssertionError("a cancelled run must not start its agent")

    monkeypatch.setattr(rm.asyncio, "create_subprocess_exec", _never)

    run = await manager.start_run(spec, project_id, "/tmp/p", "build", "u1")
    await asyncio.sleep(0)
    assert await manager.cancel_run(run.id) is True

    gate.release()  # a slot frees up
    for _ in range(50):
        if not manager.is_running(spec.id):
            break
        await asyncio.sleep(0.01)

    async with factory() as db:
        row = await db.get(AgentRun, run.id)
        assert row.status == "cancelled"
        assert row.finished_at is not None
    assert notified == ["cancelled"]
    assert not manager.is_running(spec.id)


@pytest.mark.asyncio
async def test_cancel_answers_false_for_a_run_it_does_not_hold():
    from server.services.run_manager import RunManager

    assert await RunManager().cancel_run("unknown-run") is False
