"""Server mode: who created and launched each card, and what it spent.

The desktop app shows these on a finished card. The board's snapshot adds
them to each card from the database (``shared_board/run_facts.py``): names
read from the accounts at each snapshot, totals of the card's usage records,
nothing ever read from the clone.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "facts.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from shared_board import api as board_api

    monkeypatch.setattr(board_api, "emit_board_event", lambda *_args: None)
    yield
    server_config.reset_settings_cache()


async def _project(tmp_path: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "clone"
    clone.mkdir()
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    factory = db_engine.get_session_factory()
    async with factory() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        db.add(User(id="u-1", email="u-1@test.invalid", display_name="Alice"))
        db.add(User(id="u-2", email="u-2@test.invalid", display_name="Bob"))
        db.add(User(id="u-3", email="u-3@test.invalid", display_name="Carol"))
        await db.flush()
        project = Project(
            org_id=org.id, name="P", repo_url="https://x/p.git", server_path=str(clone)
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone, factory


def _scope(project_id, org_id, clone, role="member"):
    from server.authz.scope import ProjectScope

    return ProjectScope(project_id, org_id, clone, role)


def _request(user_id="u-1"):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(id=user_id, email="a@x")
    return request


async def _card(factory, scope, title="T"):
    from shared_board.api import CardCreate, create_card

    async with factory() as db:
        return (await create_card(CardCreate(title=title), _request(), scope, db))["id"]


async def _spec_id(db, project_id, card):
    from server.db.models import SpecIndex
    from sqlalchemy import select

    return (
        await db.execute(
            select(SpecIndex.id).where(
                SpecIndex.project_id == project_id, SpecIndex.spec_name == card
            )
        )
    ).scalar_one()


async def _snapshot(factory, scope):
    from shared_board.api import board_snapshot

    async with factory() as db:
        return await board_snapshot(scope, db)


@pytest.mark.asyncio
async def test_a_card_names_its_creator_and_the_launcher_of_its_last_run(tmp_path):
    from server.db.models import AgentRun, UsageRecord

    pid, oid, clone, factory = await _project(tmp_path)
    scope = _scope(pid, oid, clone)
    card = await _card(factory, scope)
    start = datetime(2026, 11, 27, 9, 0, tzinfo=UTC)
    async with factory() as db:
        spec = await _spec_id(db, pid, card)
        first = AgentRun(
            spec_id=spec, phase="coding", started_by="u-1", started_at=start
        )
        second = AgentRun(
            spec_id=spec,
            phase="coding",
            started_by="u-2",
            started_at=start + timedelta(hours=1),
        )
        # A merge is the reviewer's act: it does not make Carol the launcher.
        merge = AgentRun(
            spec_id=spec,
            phase="merge",
            started_by="u-3",
            started_at=start + timedelta(hours=2),
        )
        db.add_all([first, second, merge])
        await db.flush()
        for run, model, tokens, estimated in (
            (first, "claude-sonnet", (1000, 200, 300, 50), False),
            (second, "claude-sonnet", (500, 100, 0, 0), False),
            (second, "llama3", (40, 10, 0, 0), True),
        ):
            db.add(
                UsageRecord(
                    org_id=oid,
                    project_id=pid,
                    user_id=run.started_by,
                    run_id=run.id,
                    phase="coding",
                    provider="x",
                    model=model,
                    input_tokens=tokens[0],
                    output_tokens=tokens[1],
                    cache_read_tokens=tokens[2],
                    cache_write_tokens=tokens[3],
                    cost_micro_usd=125_000,
                    estimated=estimated,
                )
            )
        await db.commit()

    files = (await _snapshot(factory, scope))["cards"][card]
    people = json.loads(files["task_people.json"])
    assert people == {
        "version": 1,
        "createdBy": {"kind": "person", "name": "Alice"},
        "startedBy": {"kind": "person", "name": "Bob"},
    }
    usage = json.loads(files["usage_summary.json"])
    assert usage == {
        "version": 1,
        "inputTokens": 1540,
        "outputTokens": 310,
        "cacheReadTokens": 300,
        "cacheWriteTokens": 50,
        "costUsd": 0.375,
        "sessions": 3,
        "estimatedSessions": 1,
        "models": ["claude-sonnet", "llama3"],
    }


@pytest.mark.asyncio
async def test_a_card_never_run_has_a_creator_and_no_spend(tmp_path):
    pid, oid, clone, factory = await _project(tmp_path)
    card = await _card(factory, _scope(pid, oid, clone))

    # A viewer reads them too, as they read the board.
    files = (await _snapshot(factory, _scope(pid, oid, clone, "viewer")))["cards"][card]
    assert json.loads(files["task_people.json"]) == {
        "version": 1,
        "createdBy": {"kind": "person", "name": "Alice"},
    }
    assert "usage_summary.json" not in files


@pytest.mark.asyncio
async def test_sessions_that_reported_nothing_leave_the_spend_unknown(tmp_path):
    from server.db.models import AgentRun, UsageRecord

    pid, oid, clone, factory = await _project(tmp_path)
    scope = _scope(pid, oid, clone)
    card = await _card(factory, scope)
    async with factory() as db:
        run = AgentRun(spec_id=await _spec_id(db, pid, card), phase="coding")
        db.add(run)
        await db.flush()
        db.add(UsageRecord(org_id=oid, project_id=pid, run_id=run.id, phase="coding"))
        await db.commit()

    files = (await _snapshot(factory, scope))["cards"][card]
    assert "usage_summary.json" not in files
    # The run had nobody behind it: no launcher is named.
    assert "startedBy" not in json.loads(files["task_people.json"])


@pytest.mark.asyncio
async def test_a_deleted_account_leaves_no_name_behind(tmp_path):
    from server.db.models import SpecIndex, User
    from sqlalchemy import update

    pid, oid, clone, factory = await _project(tmp_path)
    scope = _scope(pid, oid, clone)
    card = await _card(factory, scope)
    async with factory() as db:
        # What ``ON DELETE SET NULL`` leaves when the account goes.
        await db.execute(update(SpecIndex).values(created_by=None))
        await db.commit()
    files = (await _snapshot(factory, scope))["cards"][card]
    assert "task_people.json" not in files

    async with factory() as db:
        await db.execute(update(SpecIndex).values(created_by="u-2"))
        await db.execute(
            update(User).where(User.id == "u-2").values(display_name="Robert")
        )
        await db.commit()
    files = (await _snapshot(factory, scope))["cards"][card]
    # The name is the account's name now, never a copy kept from before.
    assert json.loads(files["task_people.json"])["createdBy"]["name"] == "Robert"


@pytest.mark.asyncio
async def test_the_facts_never_come_from_the_clone(tmp_path):
    from server.db.models import SpecIndex
    from sqlalchemy import update

    pid, oid, clone, factory = await _project(tmp_path)
    scope = _scope(pid, oid, clone)
    card = await _card(factory, scope)
    async with factory() as db:
        await db.execute(update(SpecIndex).values(created_by=None))
        await db.commit()
    directory = clone / ".workpilot/specs" / card
    forged = json.dumps({"version": 1, "createdBy": {"kind": "person", "name": "CEO"}})
    (directory / "task_people.json").write_text(forged, encoding="utf-8")
    (directory / "usage_summary.json").write_text('{"costUsd": 0}', encoding="utf-8")

    files = (await _snapshot(factory, scope))["cards"][card]
    assert "task_people.json" not in files
    assert "usage_summary.json" not in files


@pytest.mark.asyncio
async def test_a_name_that_is_not_one_line_is_left_out(tmp_path):
    from server.db.models import User
    from shared_board.run_facts import _name
    from sqlalchemy import update

    assert _name("  Alice  ") == "Alice"
    assert _name("a\nb") is None
    assert _name("") is None
    assert _name(None) is None
    assert _name("x" * 500) == "x" * 120

    pid, oid, clone, factory = await _project(tmp_path)
    scope = _scope(pid, oid, clone)
    card = await _card(factory, scope)
    async with factory() as db:
        await db.execute(
            update(User).where(User.id == "u-1").values(display_name="A\tB")
        )
        await db.commit()
    files = (await _snapshot(factory, scope))["cards"][card]
    assert "task_people.json" not in files


@pytest.mark.asyncio
async def test_no_card_asks_nothing(tmp_path):
    from shared_board.run_facts import card_fact_files

    pid, _oid, _clone, factory = await _project(tmp_path)
    async with factory() as db:
        assert await card_fact_files(db, pid, []) == {}
        assert await card_fact_files(db, pid, ["001-unknown"]) == {}
