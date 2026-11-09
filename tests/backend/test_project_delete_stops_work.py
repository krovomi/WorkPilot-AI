"""Deleting a server project stops its work first, and its rows go with it (F175).

Before: the route deleted the row and the clone while the project's agents and
jobs kept running in it, and SQLite (the default database of a small
deployment) ignored every ``ondelete`` because foreign keys are off unless each
connection turns them on: specs, runs and members outlived their project.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select, text

from tests.backend import test_admin_api as _admin_fixtures
from tests.backend.test_admin_api import (  # noqa: F401  (fixtures)
    _principal_for,
    _settings,
)
from tests.backend.test_server_access_checks import _app_as, _bearer, _project

# pytest finds fixtures by name in the module.
env = _admin_fixtures.env

pytestmark = pytest.mark.asyncio


class _Proc:
    """An agent process that runs until it is terminated."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self._ended = asyncio.Event()

    def terminate(self) -> None:
        self.returncode = -15
        self._ended.set()

    async def communicate(self):
        await self._ended.wait()
        return b"", b""


def _fake_agents(monkeypatch, manager):
    from server.services import run_manager as rm

    async def _spawn(*_a, **_k):
        return _Proc()

    async def _env(*_a):
        return {}

    monkeypatch.setattr(rm.asyncio, "create_subprocess_exec", _spawn)
    monkeypatch.setattr(rm, "build_command", lambda *a: ["agent"])
    monkeypatch.setattr(rm, "confine", lambda cmd, *a: cmd)
    monkeypatch.setattr(rm, "card_environment", lambda *a: {})
    monkeypatch.setattr(manager, "_build_env", _env)

    async def _notify(*_a):
        return None

    monkeypatch.setattr(manager, "_notify", _notify)


async def _spec(project_id: str):
    from server.db.engine import get_session_factory
    from server.db.models import SpecIndex

    async with get_session_factory()() as db:
        spec = SpecIndex(project_id=project_id, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        await db.refresh(spec)
        return spec


async def _until(condition, tries: int = 200) -> None:
    for _ in range(tries):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never held")


async def test_stop_project_ends_that_project_s_runs_and_no_other(env, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun
    from server.services.run_manager import RunManager

    manager = RunManager()
    _fake_agents(monkeypatch, manager)
    owner = env["users"]["admin"]
    mine, other = await _project(env["acme"], owner), await _project(env["acme"], owner)
    spec_a, spec_b = await _spec(mine), await _spec(other)

    run_a = await manager.start_run(spec_a, mine, "/tmp/a", "build", owner)
    run_b = await manager.start_run(spec_b, other, "/tmp/b", "build", owner)
    await _until(lambda: {run_a.id, run_b.id} <= set(manager._active))

    assert await manager.stop_project(mine, timeout=5) == 1
    # Returned once the run had ended, not merely once it was asked to.
    assert not manager.is_running(spec_a.id)
    assert manager.is_running(spec_b.id)
    async with get_session_factory()() as db:
        assert (await db.get(AgentRun, run_a.id)).status == "cancelled"

    await manager.stop_project(other, timeout=5)
    assert not manager.is_running(spec_b.id)


async def test_stop_project_of_the_jobs_cancels_only_that_project(monkeypatch):
    from server.services.project_jobs import ProjectJobs

    jobs = ProjectJobs()
    jobs._running = {
        ("p1", "ideation"): "j1",
        ("p1", "insights"): "j2",
        ("p2", "x"): "j3",
    }
    cancelled: list[str] = []

    async def _cancel(job_id: str) -> bool:
        cancelled.append(job_id)
        jobs._running = {k: v for k, v in jobs._running.items() if v != job_id}
        return True

    monkeypatch.setattr(jobs, "cancel", _cancel)
    assert await jobs.stop_project("p1", timeout=1) == 2
    assert sorted(cancelled) == ["j1", "j2"]
    assert jobs.is_tracked("j3")


async def test_the_delete_route_stops_the_work_before_removing_anything(
    env, monkeypatch
):
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, Project, ProjectMember, SpecIndex
    from server.routers import projects

    owner = env["users"]["admin"]
    project_id = await _project(env["acme"], owner)
    spec = await _spec(project_id)
    async with get_session_factory()() as db:
        db.add(AgentRun(spec_id=spec.id, phase="build", status="succeeded"))
        await db.commit()

    order: list[str] = []

    class _Stops:
        def __init__(self, name: str) -> None:
            self.name = name

        async def stop_project(self, pid: str) -> int:
            async with get_session_factory()() as db:
                # Still there: nothing was deleted before the work stopped.
                assert await db.get(Project, pid) is not None
            order.append(self.name)
            return 0

    monkeypatch.setattr(projects, "get_run_manager", lambda: _Stops("runs"))
    monkeypatch.setattr(projects, "get_project_jobs", lambda: _Stops("jobs"))
    monkeypatch.setattr(projects, "delete_clone", lambda pid: order.append("clone"))

    principal = await _principal_for(env, "admin")
    async with _app_as(projects.router, principal) as c:
        resp = await c.delete(f"/projects/{project_id}", headers=_bearer(owner))
    assert resp.status_code == 200, resp.text
    assert order == ["runs", "jobs", "clone"]

    async with get_session_factory()() as db:
        for model, column in (
            (SpecIndex, SpecIndex.project_id),
            (ProjectMember, ProjectMember.project_id),
        ):
            assert (
                await db.scalars(select(model).where(column == project_id))
            ).all() == []
        assert (
            await db.scalars(select(AgentRun).where(AgentRun.spec_id == spec.id))
        ).all() == []


async def test_every_connection_of_a_sqlite_server_enforces_foreign_keys(env):
    from server.db.engine import get_session_factory

    for _ in range(2):
        async with get_session_factory()() as db:
            assert (await db.execute(text("PRAGMA foreign_keys"))).scalar() == 1
