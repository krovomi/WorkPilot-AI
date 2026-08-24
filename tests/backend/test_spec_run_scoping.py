"""A run can only be cancelled through the spec that actually owns it.

``run_id`` is a free-form path segment. The handler used to pass it straight
to ``RunManager.cancel_run``, which terminates by id alone — so any member of
any project could kill a run belonging to a project they cannot even see,
given (or guessing) its id.
"""

from __future__ import annotations

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
    return db_engine.get_session_factory()()


@pytest.mark.asyncio
async def test_cancel_rejects_a_run_belonging_to_another_spec(monkeypatch):
    from fastapi import HTTPException
    from server.auth.deps import CurrentUser
    from server.db.models import AgentRun, Project, SpecIndex
    from server.routers.specs import cancel_run
    from server.services import run_manager as run_manager_module

    cancelled: list[str] = []

    class _SpyManager:
        async def cancel_run(self, run_id: str) -> bool:
            cancelled.append(run_id)
            return True

    monkeypatch.setattr(run_manager_module, "get_run_manager", lambda: _SpyManager())

    async with await _fresh_db() as db:
        mine = Project(name="Mine", repo_url="https://x/a.git", server_path="/tmp/a")
        theirs = Project(
            name="Theirs", repo_url="https://x/b.git", server_path="/tmp/b"
        )
        db.add_all([mine, theirs])
        await db.flush()

        my_spec = SpecIndex(project_id=mine.id, spec_name="my-spec", status="backlog")
        their_spec = SpecIndex(
            project_id=theirs.id, spec_name="their-spec", status="backlog"
        )
        db.add_all([my_spec, their_spec])
        await db.flush()

        their_run = AgentRun(spec_id=their_spec.id, phase="build", status="running")
        db.add(their_run)
        await db.commit()

        attacker = CurrentUser(
            id="u-attacker", email="a@example.com", display_name="A", role="member"
        )

        with pytest.raises(HTTPException) as exc:
            await cancel_run(
                project_id=mine.id,
                spec_id=my_spec.id,
                run_id=their_run.id,
                user=attacker,
                db=db,
            )

        assert exc.value.status_code == 404
        assert cancelled == []  # the run manager was never reached


@pytest.mark.asyncio
async def test_cancel_accepts_a_run_of_the_addressed_spec(monkeypatch):
    from server.auth.deps import CurrentUser
    from server.db.models import AgentRun, Project, SpecIndex
    from server.routers.specs import cancel_run
    from server.services import run_manager as run_manager_module

    cancelled: list[str] = []

    class _SpyManager:
        async def cancel_run(self, run_id: str) -> bool:
            cancelled.append(run_id)
            return True

    monkeypatch.setattr(run_manager_module, "get_run_manager", lambda: _SpyManager())

    async with await _fresh_db() as db:
        project = Project(name="P", repo_url="https://x/a.git", server_path="/tmp/a")
        db.add(project)
        await db.flush()
        spec = SpecIndex(project_id=project.id, spec_name="s", status="backlog")
        db.add(spec)
        await db.flush()
        run = AgentRun(spec_id=spec.id, phase="build", status="running")
        db.add(run)
        await db.commit()

        user = CurrentUser(
            id="u-owner", email="o@example.com", display_name="O", role="member"
        )
        result = await cancel_run(
            project_id=project.id,
            spec_id=spec.id,
            run_id=run.id,
            user=user,
            db=db,
        )

        assert result == {"cancelled": True}
        assert cancelled == [run.id]
