"""What a server start does to organization memberships.

``init_db`` runs on every start. It refreshes the built-in roles and ensures
the default organization; moving the users of a single-tenant deployment into
that organization is a one-time upgrade step, taken once and then recorded.
These tests restart the same database several times and check who belongs to
which organization afterwards.
"""

from __future__ import annotations

import asyncio
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
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "bootstrap.sqlite3").replace("\\", "/"),
    )
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _start() -> None:
    """One server start against this test's database."""
    from server.db import engine as db_engine

    await db_engine.dispose_engine()
    await db_engine.init_db()


@pytest_asyncio.fixture()
async def started():
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await _start()
    yield db_engine.get_session_factory
    await db_engine.dispose_engine()


async def _default_org_id(factory) -> str:
    from server.db.models import Organization
    from server.db.seed import DEFAULT_ORG_SLUG
    from sqlalchemy import select

    async with factory()() as db:
        return await db.scalar(
            select(Organization.id).where(Organization.slug == DEFAULT_ORG_SLUG)
        )


async def _org_ids_of(factory, user_id: str) -> set[str]:
    from server.db.models import OrgMember
    from sqlalchemy import select

    async with factory()() as db:
        return set(
            await db.scalars(
                select(OrgMember.org_id).where(OrgMember.user_id == user_id)
            )
        )


async def _add_user(factory, email: str, role: str = "member") -> str:
    from server.db.models import User

    async with factory()() as db:
        user = User(
            id=str(uuid.uuid4()),
            email=email,
            display_name=email.split("@")[0],
            role=role,
        )
        db.add(user)
        await db.commit()
        return user.id


async def _add_org_with_member(factory, slug: str, user_id: str) -> str:
    from server.db.models import Organization, OrgMember, Role
    from sqlalchemy import select

    async with factory()() as db:
        org = Organization(id=str(uuid.uuid4()), name=slug.title(), slug=slug)
        db.add(org)
        await db.flush()
        role_id = await db.scalar(
            select(Role.id).where(Role.slug == "admin", Role.org_id.is_(None))
        )
        db.add(OrgMember(org_id=org.id, user_id=user_id, role_id=role_id))
        await db.commit()
        return org.id


class TestRestartKeepsMembershipsAsTheyAre:
    async def test_a_member_of_another_organization_stays_out_of_the_default_one(
        self, started
    ):
        user_id = await _add_user(started, "lead@globex.test")
        globex = await _add_org_with_member(started, "globex", user_id)

        await _start()
        await _start()

        assert await _org_ids_of(started, user_id) == {globex}

    async def test_a_project_of_another_organization_keeps_its_organization(
        self, started
    ):
        from server.db.models import Project

        user_id = await _add_user(started, "lead@globex.test")
        globex = await _add_org_with_member(started, "globex", user_id)
        async with started()() as db:
            project = Project(
                org_id=globex,
                name="rocket",
                repo_url="https://example.com/rocket.git",
                server_path="/srv/repos/rocket",
                created_by=user_id,
            )
            db.add(project)
            await db.commit()
            project_id = project.id

        await _start()

        async with started()() as db:
            assert (await db.get(Project, project_id)).org_id == globex

    async def test_a_user_who_joined_no_organization_stays_without_one(self, started):
        """An account created after the first start is placed by an admin, not by a restart."""
        user_id = await _add_user(started, "new@example.test")

        await _start()
        await _start()

        assert await _org_ids_of(started, user_id) == set()

    async def test_a_person_removed_from_the_default_organization_stays_removed(
        self, started
    ):
        from server.db.models import OrgMember, Role
        from sqlalchemy import delete, select

        default_org = await _default_org_id(started)
        user_id = await _add_user(started, "former@example.test")
        async with started()() as db:
            role_id = await db.scalar(
                select(Role.id).where(Role.slug == "viewer", Role.org_id.is_(None))
            )
            db.add(OrgMember(org_id=default_org, user_id=user_id, role_id=role_id))
            await db.commit()
            await db.execute(delete(OrgMember).where(OrgMember.user_id == user_id))
            await db.commit()

        await _start()

        assert await _org_ids_of(started, user_id) == set()

    async def test_the_default_organization_and_roles_are_still_ensured(self, started):
        from server.authz.roles import SYSTEM_ROLE_SLUGS
        from server.db.models import Role
        from sqlalchemy import select

        await _start()

        assert await _default_org_id(started)
        async with started()() as db:
            slugs = set(
                await db.scalars(select(Role.slug).where(Role.org_id.is_(None)))
            )
        assert slugs == SYSTEM_ROLE_SLUGS


class TestSingleTenantDeploymentUpgrade:
    async def test_existing_users_join_the_default_organization_once(self, started):
        """The state an upgrade finds: users and no membership, step not yet taken."""
        from server.db.models import DeploymentMarker
        from sqlalchemy import delete

        admin = await _add_user(started, "admin@example.test", role="admin")
        dev = await _add_user(started, "dev@example.test")
        async with started()() as db:
            await db.execute(delete(DeploymentMarker))
            await db.commit()

        await _start()

        default_org = await _default_org_id(started)
        assert await _org_ids_of(started, admin) == {default_org}
        assert await _org_ids_of(started, dev) == {default_org}

        later = await _add_user(started, "later@example.test")
        await _start()

        assert await _org_ids_of(started, later) == set()

    async def test_the_upgrade_leaves_a_member_of_another_organization_in_place(
        self, started
    ):
        from server.db.models import DeploymentMarker
        from sqlalchemy import delete

        lead = await _add_user(started, "lead@globex.test")
        globex = await _add_org_with_member(started, "globex", lead)
        dev = await _add_user(started, "dev@example.test")
        async with started()() as db:
            await db.execute(delete(DeploymentMarker))
            await db.commit()

        await _start()

        assert await _org_ids_of(started, lead) == {globex}
        assert await _org_ids_of(started, dev) == {await _default_org_id(started)}


class TestAlembicUpgradedDatabase:
    async def test_a_start_after_the_migrations_does_not_repeat_the_upgrade_step(
        self,
    ):
        pytest.importorskip("alembic")
        from alembic import command
        from alembic.config import Config
        from server.db import engine as db_engine

        ini = _BACKEND / "server" / "db" / "alembic.ini"
        # Alembic's env runs its own event loop; give it a thread of its own.
        await asyncio.to_thread(command.upgrade, Config(str(ini)), "head")

        db_engine._engine = None
        db_engine._session_factory = None
        factory = db_engine.get_session_factory
        try:
            user_id = await _add_user(factory, "new@example.test")
            await _start()
            assert await _org_ids_of(factory, user_id) == set()
        finally:
            await db_engine.dispose_engine()
