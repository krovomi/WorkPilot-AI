"""Invitations and the organization the invitee joins.

An invitation is issued in the organization the admin is acting in and records
it; accepting it makes the new account a member of that organization, with the
recorded role, and of no other. The routes are exercised through a real app
with a real database, the auth middleware replaced by one that injects a chosen
principal and active organization.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

pytestmark = pytest.mark.asyncio

_VALID_SECRET = "x" * 48
_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture(autouse=True)
def _settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "invites.sqlite3").replace("\\", "/"),
    )
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


@pytest_asyncio.fixture()
async def env():
    """Two tenants besides the default one, a platform admin, a project in each."""
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()

    factory = db_engine.get_session_factory()
    async with factory() as db:
        acme = Organization(id=str(uuid.uuid4()), name="Acme", slug="acme")
        globex = Organization(id=str(uuid.uuid4()), name="Globex", slug="globex")
        ops = User(
            id=str(uuid.uuid4()),
            email="ops@example.test",
            display_name="ops",
            role="admin",
        )
        db.add_all([acme, globex, ops])
        await db.flush()
        projects = {}
        for key, org in (("acme", acme), ("globex", globex)):
            project = Project(
                org_id=org.id,
                name=f"{key}-app",
                repo_url=f"https://example.com/{key}.git",
                server_path=f"/srv/repos/{key}",
            )
            db.add(project)
            await db.flush()
            projects[key] = project.id
        await db.commit()

        yield {
            "acme": acme.id,
            "globex": globex.id,
            "ops": ops.id,
            "projects": projects,
        }

    await db_engine.dispose_engine()


def _session():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _memberships(user_id: str) -> dict[str, str]:
    """``{org_id: role slug}`` for this user."""
    from server.db.models import OrgMember, Role
    from sqlalchemy import select

    async with _session() as db:
        rows = await db.execute(
            select(OrgMember.org_id, Role.slug)
            .join(Role, Role.id == OrgMember.role_id)
            .where(OrgMember.user_id == user_id)
        )
        return dict(rows.all())


async def _invite(env, org_key: str, email: str, **kwargs):
    from server.auth.invitations import create_invitation

    async with _session() as db:
        return await create_invitation(
            db,
            email=email,
            org_id=env[org_key],
            invited_by=env["ops"],
            **kwargs,
        )


async def _accept(token: str):
    from server.auth.invitations import accept_invitation

    async with _session() as db:
        return await accept_invitation(db, token, "New person", _PASSWORD)


class TestAcceptance:
    async def test_the_new_account_joins_the_invitation_organization(self, env):
        invitation, token = await _invite(env, "globex", "new@globex.test")
        assert invitation.org_id == env["globex"]

        user = await _accept(token)

        assert await _memberships(user.id) == {env["globex"]: "contributor"}

    async def test_the_recorded_organization_role_is_the_one_granted(self, env):
        _, token = await _invite(
            env, "acme", "reader@acme.test", role="viewer", org_role="analyst"
        )

        user = await _accept(token)

        assert await _memberships(user.id) == {env["acme"]: "analyst"}

    async def test_the_new_account_stays_in_that_organization_after_a_restart(
        self, env
    ):
        from server.db import engine as db_engine

        _, token = await _invite(env, "globex", "new@globex.test")
        user = await _accept(token)

        await db_engine.dispose_engine()
        await db_engine.init_db()

        assert set(await _memberships(user.id)) == {env["globex"]}

    async def test_a_project_invitation_also_grants_the_project(self, env):
        from server.db.models import ProjectMember
        from sqlalchemy import select

        _, token = await _invite(
            env, "acme", "dev@acme.test", project_id=env["projects"]["acme"]
        )
        user = await _accept(token)

        async with _session() as db:
            project_ids = set(
                await db.scalars(
                    select(ProjectMember.project_id).where(
                        ProjectMember.user_id == user.id
                    )
                )
            )
        assert project_ids == {env["projects"]["acme"]}
        assert set(await _memberships(user.id)) == {env["acme"]}

    async def test_an_invitation_without_an_organization_creates_no_account(self, env):
        from datetime import UTC, datetime, timedelta

        from server.auth.invitations import (
            InvitationError,
            hash_token,
            lookup_invitation,
        )
        from server.db.models import Invitation, User
        from sqlalchemy import select

        token = "legacy-token-without-org"  # pragma: allowlist secret
        async with _session() as db:
            db.add(
                Invitation(
                    email="legacy@example.test",
                    role="member",
                    token_hash=hash_token(token),
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                )
            )
            await db.commit()

        with pytest.raises(InvitationError):
            await _accept(token)
        # Nor is it offered as valid when looked up.
        async with _session() as db:
            with pytest.raises(InvitationError):
                await lookup_invitation(db, token)

        async with _session() as db:
            assert (
                await db.scalar(
                    select(User.id).where(User.email == "legacy@example.test")
                )
                is None
            )


class TestCreation:
    async def test_a_project_of_another_organization_is_refused(self, env):
        from server.auth.invitations import InvitationError

        with pytest.raises(InvitationError):
            await _invite(
                env, "acme", "dev@acme.test", project_id=env["projects"]["globex"]
            )

    async def test_an_organization_role_of_another_organization_is_refused(self, env):
        from server.auth.invitations import InvitationError
        from server.db.models import Role

        async with _session() as db:
            db.add(
                Role(
                    org_id=env["globex"],
                    slug="globex-reviewer",
                    name="Reviewer",
                    scope="org",
                    permissions=[],
                )
            )
            await db.commit()

        with pytest.raises(InvitationError):
            await _invite(env, "acme", "dev@acme.test", org_role="globex-reviewer")

    async def test_an_unknown_organization_is_refused(self, env):
        from server.auth.invitations import InvitationError, create_invitation

        async with _session() as db:
            with pytest.raises(InvitationError):
                await create_invitation(
                    db,
                    email="dev@example.test",
                    org_id=str(uuid.uuid4()),
                    invited_by=env["ops"],
                )


def _client(
    env,
    org_key: str | None,
    *,
    platform_role: str = "admin",
    permissions: frozenset[str] = frozenset(),
) -> AsyncClient:
    """The invitations router, called by `ops` acting in `org_key`: the
    platform admin by default, else a person holding `permissions` there."""
    from server.authz.principal import Principal
    from server.routers.invitations import router

    org_id = env[org_key] if org_key else None
    principal = Principal(
        id=env["ops"],
        email="ops@example.test",
        display_name="ops",
        platform_role=platform_role,
        org_id=org_id,
        permissions=permissions,
    )

    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        request.state.org_id = org_id
        return await call_next(request)

    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class TestRoutes:
    async def test_an_invitation_is_issued_in_the_active_organization(self, env):
        from server.db.models import Invitation

        async with _client(env, "acme") as c:
            resp = await c.post(
                "/auth/invitations", json={"email": "dev@acme.example.com"}
            )
        assert resp.status_code == 201, resp.text

        async with _session() as db:
            invitation = await db.get(Invitation, resp.json()["id"])
        assert invitation.org_id == env["acme"]
        assert invitation.org_role_id is not None

    async def test_issuing_without_an_active_organization_is_refused(self, env):
        async with _client(env, None) as c:
            resp = await c.post(
                "/auth/invitations", json={"email": "dev@acme.example.com"}
            )
        assert resp.status_code == 400

    async def test_another_organization_neither_lists_nor_revokes_it(self, env):
        async with _client(env, "acme") as c:
            created = await c.post(
                "/auth/invitations", json={"email": "dev@acme.example.com"}
            )
            invitation_id = created.json()["id"]
            listed_in_acme = await c.get("/auth/invitations")

        async with _client(env, "globex") as c:
            listed_in_globex = await c.get("/auth/invitations")
            revoked = await c.delete(f"/auth/invitations/{invitation_id}")

        assert [i["id"] for i in listed_in_acme.json()] == [invitation_id]
        assert listed_in_globex.json() == []
        assert revoked.status_code == 404


#: What the built-in organization admin role holds about invitations.
_ORG_ADMIN = frozenset({"org.invitation.read", "org.invitation.write"})


class TestWhoMayInvite:
    """An organization admin invites into their organization; only a
    platform admin makes a server administrator."""

    async def test_an_organization_admin_invites_a_member(self, env):
        async with _client(
            env, "acme", platform_role="member", permissions=_ORG_ADMIN
        ) as c:
            created = await c.post(
                "/auth/invitations",
                json={"email": "dev@acme.example.com", "role": "member"},
            )
            listed = await c.get("/auth/invitations")
        assert created.status_code == 201, created.text
        assert [i["id"] for i in listed.json()] == [created.json()["id"]]

    async def test_an_organization_admin_cannot_invite_a_server_administrator(
        self, env
    ):
        from server.db.models import Invitation
        from sqlalchemy import select

        async with _client(
            env, "acme", platform_role="member", permissions=_ORG_ADMIN
        ) as c:
            resp = await c.post(
                "/auth/invitations",
                json={"email": "boss@acme.example.com", "role": "admin"},
            )
        assert resp.status_code == 403
        async with _session() as db:
            found = await db.scalar(
                select(Invitation).where(Invitation.email == "boss@acme.example.com")
            )
        assert found is None

    async def test_a_platform_admin_can_invite_a_server_administrator(self, env):
        async with _client(env, "acme") as c:
            resp = await c.post(
                "/auth/invitations",
                json={"email": "ops2@acme.example.com", "role": "admin"},
            )
        assert resp.status_code == 201, resp.text

    async def test_without_the_invitation_permissions_nothing_is_reached(self, env):
        async with _client(
            env,
            "acme",
            platform_role="member",
            permissions=frozenset({"org.invitation.read"}),
        ) as c:
            issued = await c.post(
                "/auth/invitations", json={"email": "dev@acme.example.com"}
            )
            revoked = await c.delete("/auth/invitations/whatever")
        async with _client(env, "acme", platform_role="member") as c:
            listed = await c.get("/auth/invitations")
        assert issued.status_code == 403
        assert revoked.status_code == 403
        assert listed.status_code == 403
