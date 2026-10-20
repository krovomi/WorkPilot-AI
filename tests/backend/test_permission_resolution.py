"""Effective permissions, and the tenant boundary they enforce.

The claim being tested is the one the whole feature rests on: a member of one
organization resolves to no permissions at all in another, whatever their role
at home, and whatever their token says.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server.authz import engine as authz_engine  # noqa: E402
from server.authz import tenancy  # noqa: E402
from server.authz.roles import system_role  # noqa: E402
from server.db.models import (  # noqa: E402
    Base,
    Organization,
    OrgMember,
    Project,
    ProjectMember,
    Role,
    User,
)

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture()
async def db(tmp_path):
    url = "sqlite+aiosqlite:///" + str(tmp_path / "perm.sqlite3").replace("\\", "/")
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        from server.db.seed import seed_system_roles

        await conn.run_sync(seed_system_roles)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _role_id(db, slug: str) -> str:
    from sqlalchemy import select

    return await db.scalar(
        select(Role.id).where(Role.slug == slug, Role.org_id.is_(None))
    )


async def _org(db, slug: str, *, active: bool = True, disabled: list | None = None):
    org = Organization(
        id=str(uuid.uuid4()),
        name=slug.title(),
        slug=slug,
        is_active=active,
        settings={"disabled_permissions": disabled} if disabled else None,
    )
    db.add(org)
    await db.commit()
    return org


async def _user(db, email: str, platform_role: str = "member"):
    user = User(
        id=str(uuid.uuid4()),
        email=email,
        display_name=email.split("@")[0],
        role=platform_role,
    )
    db.add(user)
    await db.commit()
    return user


async def _join(db, user, org, slug: str):
    db.add(
        OrgMember(
            id=str(uuid.uuid4()),
            org_id=org.id,
            user_id=user.id,
            role_id=await _role_id(db, slug),
        )
    )
    await db.commit()


async def _resolve(db, user, org_id, project_id=None):
    return await authz_engine.resolve_permissions(
        db,
        user_id=user.id,
        platform_role=user.role,
        org_id=org_id,
        project_id=project_id,
    )


class TestRoleGrants:
    async def test_role_permissions_are_returned(self, db):
        org = await _org(db, "acme")
        user = await _user(db, "dev@acme.test")
        await _join(db, user, org, "contributor")

        perms, slug = await _resolve(db, user, org.id)
        assert slug == "contributor"
        assert perms == system_role("contributor").permissions

    async def test_viewer_cannot_write_or_execute(self, db):
        org = await _org(db, "acme")
        user = await _user(db, "read@acme.test")
        await _join(db, user, org, "viewer")

        perms, _ = await _resolve(db, user, org.id)
        assert "task.read" in perms
        assert "task.write" not in perms
        assert "agent.execute" not in perms
        assert "settings.provider.read" not in perms


class TestTenantIsolation:
    async def test_a_member_of_one_org_has_nothing_in_another(self, db):
        """The boundary the whole feature exists for."""
        acme = await _org(db, "acme")
        globex = await _org(db, "globex")
        user = await _user(db, "boss@acme.test")
        await _join(db, user, acme, "owner")

        at_home, home_slug = await _resolve(db, user, acme.id)
        assert home_slug == "owner"
        assert "task.merge" in at_home

        elsewhere, other_slug = await _resolve(db, user, globex.id)
        assert elsewhere == frozenset()
        assert other_slug is None

    async def test_no_org_means_no_permissions(self, db):
        user = await _user(db, "nomad@example.test")
        perms, slug = await _resolve(db, user, None)
        assert perms == frozenset()
        assert slug is None

    async def test_org_role_never_grants_platform_permissions(self, db):
        org = await _org(db, "acme")
        user = await _user(db, "boss@acme.test")
        await _join(db, user, org, "owner")

        perms, _ = await _resolve(db, user, org.id)
        assert not {p for p in perms if p.startswith("platform.")}


class TestPlatformAdmin:
    async def test_platform_admin_gets_everything_anywhere(self, db):
        from server.authz.catalog import ALL_PERMISSION_KEYS

        org = await _org(db, "acme")
        admin = await _user(db, "ops@example.test", platform_role="admin")

        perms, slug = await _resolve(db, admin, org.id)
        assert perms == frozenset(ALL_PERMISSION_KEYS)
        assert slug == "platform-admin"

    async def test_platform_admin_needs_no_membership(self, db):
        org = await _org(db, "acme")
        admin = await _user(db, "ops@example.test", platform_role="admin")
        assert await tenancy.can_act_in(db, admin.id, "admin", org.id)

    async def test_platform_admin_cannot_act_in_a_nonexistent_org(self, db):
        admin = await _user(db, "ops@example.test", platform_role="admin")
        assert not await tenancy.can_act_in(db, admin.id, "admin", "no-such-org")


class TestOrgLevelRestrictions:
    async def test_disabled_permissions_are_subtracted(self, db):
        """A licence tier expressed in the same vocabulary as roles."""
        org = await _org(db, "acme", disabled=["agent.execute", "vcs.pr.merge"])
        user = await _user(db, "dev@acme.test")
        await _join(db, user, org, "maintainer")

        perms, _ = await _resolve(db, user, org.id)
        assert "agent.execute" not in perms
        assert "vcs.pr.merge" not in perms
        assert "task.write" in perms

    async def test_suspended_org_degrades_to_read_only(self, db):
        org = await _org(db, "acme", active=False)
        user = await _user(db, "boss@acme.test")
        await _join(db, user, org, "owner")

        perms, _ = await _resolve(db, user, org.id)
        assert perms, "an admin must still be able to see why it was suspended"
        assert all(p.endswith(".read") for p in perms)

    async def test_unknown_keys_on_a_role_are_ignored(self, db):
        """A role written by a newer build must not smuggle in unknown keys."""
        from sqlalchemy import update

        org = await _org(db, "acme")
        user = await _user(db, "dev@acme.test")
        await _join(db, user, org, "viewer")
        role_id = await _role_id(db, "viewer")
        await db.execute(
            update(Role)
            .where(Role.id == role_id)
            .values(permissions=["task.read", "task.teleport"])
        )
        await db.commit()

        perms, _ = await _resolve(db, user, org.id)
        assert perms == frozenset({"task.read"})


class TestProjectScopedRoles:
    async def test_project_role_adds_to_the_org_role(self, db):
        org = await _org(db, "acme")
        user = await _user(db, "lead@acme.test")
        await _join(db, user, org, "contributor")

        project = Project(
            id=str(uuid.uuid4()),
            org_id=org.id,
            name="alpha",
            repo_url="https://example.com/a.git",
            server_path="/srv/repos/alpha",
        )
        db.add(project)
        await db.commit()
        db.add(
            ProjectMember(
                id=str(uuid.uuid4()),
                project_id=project.id,
                user_id=user.id,
                role="member",
                role_id=await _role_id(db, "maintainer"),
            )
        )
        await db.commit()

        base, _ = await _resolve(db, user, org.id)
        assert "task.merge" not in base

        scoped, _ = await _resolve(db, user, org.id, project_id=project.id)
        assert "task.merge" in scoped, "the project role grants merge on this project"


class TestOrgResolution:
    async def test_a_single_membership_is_used_without_being_named(self, db):
        org = await _org(db, "acme")
        user = await _user(db, "dev@acme.test")
        await _join(db, user, org, "contributor")

        resolved = await tenancy.resolve_org_id(
            db,
            user_id=user.id,
            platform_role="member",
            header_value=None,
            claim_value=None,
        )
        assert resolved == org.id

    async def test_several_memberships_are_not_guessed(self, db):
        """Acting in the wrong tenant is worse than asking the client to pick."""
        acme = await _org(db, "acme")
        globex = await _org(db, "globex")
        user = await _user(db, "consultant@example.test")
        await _join(db, user, acme, "contributor")
        await _join(db, user, globex, "viewer")

        resolved = await tenancy.resolve_org_id(
            db,
            user_id=user.id,
            platform_role="member",
            header_value=None,
            claim_value=None,
        )
        assert resolved is None

    async def test_header_selects_among_memberships(self, db):
        acme = await _org(db, "acme")
        globex = await _org(db, "globex")
        user = await _user(db, "consultant@example.test")
        await _join(db, user, acme, "contributor")
        await _join(db, user, globex, "viewer")

        resolved = await tenancy.resolve_org_id(
            db,
            user_id=user.id,
            platform_role="member",
            header_value=globex.id,
            claim_value=acme.id,
        )
        assert resolved == globex.id, "the header outranks the token claim"

    async def test_a_header_naming_a_foreign_org_is_ignored(self, db):
        """The header is a convenience, never an assertion the server trusts."""
        acme = await _org(db, "acme")
        globex = await _org(db, "globex")
        user = await _user(db, "dev@acme.test")
        await _join(db, user, acme, "contributor")

        resolved = await tenancy.resolve_org_id(
            db,
            user_id=user.id,
            platform_role="member",
            header_value=globex.id,
            claim_value=None,
        )
        assert resolved == acme.id

    async def test_a_stale_claim_is_ignored_after_leaving_an_org(self, db):
        """A 15-minute token outlives a revoked membership."""
        acme = await _org(db, "acme")
        globex = await _org(db, "globex")
        user = await _user(db, "dev@acme.test")
        await _join(db, user, acme, "contributor")

        resolved = await tenancy.resolve_org_id(
            db,
            user_id=user.id,
            platform_role="member",
            header_value=None,
            claim_value=globex.id,
        )
        assert resolved == acme.id
