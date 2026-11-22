"""Server mode: a run recalls the ``team:`` memories of its starter's groups (#352).

The run's environment names the groups the person who started it belongs to,
in the organization of the run's project (``WORKPILOT_RECALL_TEAMS``), and
never a group of another tenant; the server's own value under that name is
never passed through.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

pytestmark = pytest.mark.asyncio

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _settings(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "teams.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


@pytest_asyncio.fixture()
async def env(tmp_path):
    """Acme (ada in Payments and Front team, bob in none) and Globex, where
    ada also belongs to a group though not to the organization."""
    from server.db import engine as db_engine
    from server.db.models import (
        GroupMember,
        Organization,
        OrgMember,
        Project,
        Role,
        User,
        UserGroup,
    )
    from sqlalchemy import select

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with db_engine.get_session_factory()() as db:
        acme = Organization(id=str(uuid.uuid4()), name="Acme", slug="acme")
        globex = Organization(id=str(uuid.uuid4()), name="Globex", slug="globex")
        ada = User(id=str(uuid.uuid4()), email="ada@x.test", display_name="Ada")
        bob = User(id=str(uuid.uuid4()), email="bob@x.test", display_name="Bob")
        db.add_all([acme, globex, ada, bob])
        await db.flush()
        member = await db.scalar(
            select(Role.id).where(Role.org_id.is_(None), Role.slug == "viewer")
        )
        db.add_all(
            [
                OrgMember(org_id=acme.id, user_id=ada.id, role_id=member),
                OrgMember(org_id=acme.id, user_id=bob.id, role_id=member),
            ]
        )
        groups = [
            UserGroup(org_id=acme.id, name="Payments"),
            UserGroup(org_id=acme.id, name="Front team"),
            UserGroup(org_id=acme.id, name="QA"),
            UserGroup(org_id=globex.id, name="Globex ops"),
        ]
        db.add_all(groups)
        shop = Project(
            org_id=acme.id, name="Shop", repo_url="https://x/s.git", server_path="/x"
        )
        other = Project(
            org_id=globex.id, name="Other", repo_url="https://x/o.git", server_path="/y"
        )
        db.add_all([shop, other])
        await db.flush()
        db.add_all(
            [
                GroupMember(group_id=groups[0].id, user_id=ada.id),
                GroupMember(group_id=groups[1].id, user_id=ada.id),
                GroupMember(group_id=groups[3].id, user_id=ada.id),
            ]
        )
        await db.commit()
        yield {"ada": ada.id, "bob": bob.id, "shop": shop.id, "other": other.id}
    await db_engine.dispose_engine()


async def test_a_person_s_teams_are_their_groups_in_the_project_s_org(env):
    from server.authz.groups import project_group_names
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        assert await project_group_names(db, env["ada"], env["shop"]) == [
            "Front team",
            "Payments",
        ]
        assert await project_group_names(db, env["bob"], env["shop"]) == []
        # A group of an organization she does not belong to gives nothing.
        assert await project_group_names(db, env["ada"], env["other"]) == []


async def test_a_run_names_its_starter_s_teams(env, monkeypatch):
    from brain.lifecycle import scopes
    from server.services.run_manager import RECALL_TEAMS_ENV, RunManager

    assert RECALL_TEAMS_ENV == scopes.TEAMS_ENV
    # The server's own value is never handed down.
    monkeypatch.setenv(RECALL_TEAMS_ENV, '["Everyone"]')

    manager = RunManager()
    ada = await manager.run_env(env["ada"], "run-1", env["shop"])
    assert json.loads(ada[RECALL_TEAMS_ENV]) == ["Front team", "Payments"]
    assert scopes.teams_from(ada) == {"team:front team", "team:payments"}
    bob = await manager._build_env(env["bob"], "run-2", env["shop"])
    assert bob[RECALL_TEAMS_ENV] == "[]"
    # A run without a project still says it is a server run: no team.
    assert (await manager.run_env(env["ada"], "run-3"))[RECALL_TEAMS_ENV] == "[]"
