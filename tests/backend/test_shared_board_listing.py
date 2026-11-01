"""Server mode: the board as a list of summarised cards (``GET /api/board/cards``).

The phone app draws a board from this list instead of the desktop's file
snapshot. These tests pin what a card carries (its summary, the id runs are
started with, who claimed it), that a running build's copy wins, and that a
workspace link pointing outside the clone is not followed.
"""

from __future__ import annotations

import json
import subprocess
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
        "sqlite+aiosqlite:///" + str(tmp_path / "list.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
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
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        user = User(email="ada@x.io", display_name="Ada", role="member")
        db.add_all([org, user])
        await db.flush()
        project = Project(
            org_id=org.id, name="P", repo_url="https://x/p.git", server_path=str(clone)
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone, user.id


def _card(root: Path, card_id: str, plan: dict) -> Path:
    directory = root / ".workpilot" / "specs" / card_id
    directory.mkdir(parents=True)
    (directory / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    (directory / "requirements.json").write_text(
        json.dumps({"task_description": "Long text the list does not carry"}),
        encoding="utf-8",
    )
    return directory


async def _list(pid, oid, clone):
    from server.authz.scope import ProjectScope
    from server.db.engine import get_session_factory
    from shared_board.listing import list_board_cards

    async with get_session_factory()() as db:
        return await list_board_cards(ProjectScope(pid, oid, clone, "viewer"), db)


@pytest.mark.asyncio
async def test_cards_are_summarised_newest_first_with_their_index_fields(tmp_path):
    from server.db.engine import get_session_factory
    from server.db.models import SpecIndex
    from sqlalchemy import select

    pid, oid, clone, uid = await _project(tmp_path)
    _card(clone, "001-login", {"feature": "Login", "status": "backlog"})
    _card(
        clone,
        "002-search",
        {
            "feature": "Search",
            "status": "coding",
            "phases": [{"subtasks": [{"status": "completed"}, {"status": "pending"}]}],
        },
    )
    (clone / ".workpilot" / "specs" / "notes").mkdir()

    first = await _list(pid, oid, clone)
    assert [c["id"] for c in first["cards"]] == ["002-search", "001-login"]
    search = first["cards"][0]
    assert search["title"] == "Search" and search["column"] == "in_progress"
    assert search["subtasks"] == {"completed": 1, "total": 2}
    assert "description" not in search
    assert search["specId"] and search["claimedBy"] is None

    async with get_session_factory()() as db:
        row = await db.scalar(
            select(SpecIndex).where(SpecIndex.spec_name == "002-search")
        )
        row.claimed_by = uid
        await db.commit()

    claimed = (await _list(pid, oid, clone))["cards"][0]
    assert claimed["claimedBy"] == uid and claimed["claimedByName"] == "Ada"


@pytest.mark.asyncio
async def test_a_running_build_shows_its_workspace_copy(tmp_path):
    pid, oid, clone, _ = await _project(tmp_path)
    _card(clone, "001-login", {"feature": "Login", "status": "backlog"})
    workspace = clone / ".workpilot" / "worktrees" / "tasks" / "001-login"
    _card(workspace, "001-login", {"feature": "Login", "status": "human_review"})

    card = (await _list(pid, oid, clone))["cards"][0]
    assert card["id"] == "001-login" and card["column"] == "human_review"


@pytest.mark.asyncio
async def test_a_workspace_link_leaving_the_clone_is_not_followed(tmp_path):
    pid, oid, clone, _ = await _project(tmp_path)
    _card(clone, "001-login", {"feature": "Login", "status": "backlog"})
    outside = tmp_path / "outside"
    _card(outside, "001-login", {"feature": "Stolen", "status": "done"})
    tasks = clone / ".workpilot" / "worktrees" / "tasks"
    tasks.mkdir(parents=True)
    try:
        (tasks / "001-login").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks unavailable")

    card = (await _list(pid, oid, clone))["cards"][0]
    assert card["title"] == "Login" and card["column"] == "backlog"


@pytest.mark.asyncio
async def test_an_empty_board_lists_nothing(tmp_path):
    pid, oid, clone, _ = await _project(tmp_path)
    assert await _list(pid, oid, clone) == {"cards": []}


def test_the_list_is_mounted_on_the_board_router_as_a_read():
    from shared_board.api import router

    routes = {
        (method, route.path)
        for route in router.routes
        for method in getattr(route, "methods", set())
    }
    assert ("GET", "/api/board/cards") in routes
