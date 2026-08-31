"""The administration API: permission gating, tenant scoping, and audit.

Exercised through a real app with a real database. The auth middleware is
replaced by one that injects a chosen ``Principal``, so these tests are about
*authorization* — what a given set of permissions may do — rather than about
token parsing, which ``test_auth_session_lifecycle`` already covers.
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


@pytest.fixture(autouse=True)
def _settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "admin.sqlite3").replace("\\", "/"),
    )
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


@pytest_asyncio.fixture()
async def env():
    """A fresh database with two tenants and a handful of users."""
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()

    from server.db.models import Organization, OrgMember, Role, User
    from sqlalchemy import select

    factory = db_engine.get_session_factory()
    async with factory() as db:
        acme = Organization(id=str(uuid.uuid4()), name="Acme", slug="acme")
        globex = Organization(id=str(uuid.uuid4()), name="Globex", slug="globex")
        db.add_all([acme, globex])

        users = {}
        for key, email, platform_role in (
            ("admin", "admin@acme.test", "member"),
            ("viewer", "viewer@acme.test", "member"),
            ("platform", "ops@example.test", "admin"),
            ("outsider", "dev@globex.test", "member"),
        ):
            u = User(
                id=str(uuid.uuid4()),
                email=email,
                display_name=email.split("@")[0],
                role=platform_role,
            )
            db.add(u)
            users[key] = u
        await db.flush()

        roles = {
            slug: rid
            for slug, rid in (
                await db.execute(select(Role.slug, Role.id).where(Role.org_id.is_(None)))
            ).all()
        }
        db.add_all(
            [
                OrgMember(
                    id=str(uuid.uuid4()),
                    org_id=acme.id,
                    user_id=users["admin"].id,
                    role_id=roles["admin"],
                ),
                OrgMember(
                    id=str(uuid.uuid4()),
                    org_id=acme.id,
                    user_id=users["viewer"].id,
                    role_id=roles["viewer"],
                ),
                OrgMember(
                    id=str(uuid.uuid4()),
                    org_id=globex.id,
                    user_id=users["outsider"].id,
                    role_id=roles["admin"],
                ),
            ]
        )
        await db.commit()

        yield {
            "acme": acme.id,
            "globex": globex.id,
            "users": {k: v.id for k, v in users.items()},
            "roles": roles,
        }

    await db_engine.dispose_engine()


def _client(principal) -> AsyncClient:
    """An app serving the admin router with `principal` on every request."""
    from server.routers.admin import router

    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        request.state.org_id = principal.org_id
        return await call_next(request)

    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _principal_for(env, key: str, org_key: str = "acme"):
    """Build the principal a real request would carry for this user."""
    from server.authz.engine import resolve_permissions
    from server.authz.principal import Principal
    from server.db.engine import get_session_factory
    from server.db.models import User

    user_id = env["users"][key]
    async with get_session_factory()() as db:
        user = await db.get(User, user_id)
        perms, slug = await resolve_permissions(
            db,
            user_id=user_id,
            platform_role=user.role,
            org_id=env[org_key],
        )
    return Principal(
        id=user_id,
        email=user.email,
        display_name=user.display_name,
        platform_role=user.role,
        org_id=env[org_key],
        org_role_slug=slug,
        permissions=perms,
    )


class TestPermissionCatalog:
    async def test_admin_can_read_the_catalog(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.get("/admin/permissions")
        assert resp.status_code == 200
        keys = {p["key"] for p in resp.json()}
        assert "task.merge" in keys
        assert any(p["privileged"] for p in resp.json())

    async def test_a_viewer_may_read_but_not_change_role_design(self, env):
        """Reading the catalog is not a privilege; changing roles is.

        ``viewer`` holds every non-privileged ``.read``, and ``org.role.read``
        is one of them: the catalog is the same static list in every
        deployment, so hiding it would protect nothing while making the console
        unable to explain to a user why an action is unavailable. The boundary
        that matters is ``org.role.write``, checked below.
        """
        principal = await _principal_for(env, "viewer")
        async with _client(principal) as c:
            assert (await c.get("/admin/permissions")).status_code == 200
            assert (await c.get("/admin/roles")).status_code == 200
            denied = await c.post(
                "/admin/roles",
                json={"slug": "x", "name": "X", "permissions": []},
            )
        assert denied.status_code == 403
        assert "org.role.write" in denied.json()["detail"]

    async def test_a_viewer_cannot_read_provider_credentials(self, env):
        """The read that *is* privileged, and the reason it is marked so."""
        principal = await _principal_for(env, "viewer")
        assert not principal.has("settings.provider.read")


class TestRoles:
    async def test_listing_returns_built_ins_plus_own_customs(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.get("/admin/roles")
        assert resp.status_code == 200
        slugs = {r["slug"] for r in resp.json()}
        assert {"owner", "admin", "viewer", "contributor"} <= slugs

    async def test_create_a_custom_role(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.post(
                "/admin/roles",
                json={
                    "slug": "frontend-lead",
                    "name": "Frontend Lead",
                    "permissions": ["task.read", "task.write", "task.merge"],
                },
            )
        assert resp.status_code == 201, resp.text
        assert resp.json()["permissions"] == ["task.merge", "task.read", "task.write"]
        assert resp.json()["is_system"] is False

    async def test_unknown_permission_is_refused(self, env):
        """A role granting a permission nothing implements is silently powerless."""
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.post(
                "/admin/roles",
                json={
                    "slug": "bogus",
                    "name": "Bogus",
                    "permissions": ["task.read", "task.teleport"],
                },
            )
        assert resp.status_code == 400
        assert "task.teleport" in resp.json()["detail"]

    async def test_built_in_roles_cannot_be_edited(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/roles/{env['roles']['viewer']}",
                json={"permissions": ["task.merge"]},
            )
        assert resp.status_code == 403
        assert "read-only" in resp.json()["detail"]

    async def test_a_viewer_cannot_create_roles(self, env):
        principal = await _principal_for(env, "viewer")
        async with _client(principal) as c:
            resp = await c.post(
                "/admin/roles",
                json={"slug": "x", "name": "X", "permissions": []},
            )
        assert resp.status_code == 403

    async def test_a_role_in_use_cannot_be_deleted(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            created = await c.post(
                "/admin/roles",
                json={"slug": "temp", "name": "Temp", "permissions": ["task.read"]},
            )
            role_id = created.json()["id"]
            await c.post(
                "/admin/members",
                json={"user_id": env["users"]["platform"], "role_slug": "temp"},
            )
            resp = await c.delete(f"/admin/roles/{role_id}")
        assert resp.status_code == 409
        assert "Reassign" in resp.json()["detail"]

    async def test_a_custom_role_of_another_tenant_is_invisible(self, env):
        """Reported as missing, not forbidden — a 403 confirms the id exists."""
        acme_admin = await _principal_for(env, "admin")
        async with _client(acme_admin) as c:
            created = await c.post(
                "/admin/roles",
                json={"slug": "secret", "name": "Secret", "permissions": ["task.read"]},
            )
        role_id = created.json()["id"]

        outsider = await _principal_for(env, "outsider", org_key="globex")
        async with _client(outsider) as c:
            resp = await c.patch(f"/admin/roles/{role_id}", json={"name": "Pwned"})
        assert resp.status_code == 404


class TestMembers:
    async def test_members_are_listed_per_tenant(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.get("/admin/members")
        assert resp.status_code == 200
        emails = {m["email"] for m in resp.json()}
        assert emails == {"admin@acme.test", "viewer@acme.test"}
        assert "dev@globex.test" not in emails, "cross-tenant member leak"

    async def test_role_change_is_applied_and_audited(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/members/{env['users']['viewer']}",
                json={"role_slug": "contributor"},
            )
            assert resp.status_code == 200
            assert resp.json()["role_slug"] == "contributor"

            audit = await c.get("/admin/audit")
        actions = [e["action"] for e in audit.json()]
        assert "org.member.role_changed" in actions

    async def test_an_admin_cannot_remove_themselves(self, env):
        """Otherwise a tenant ends up with no administrator at all."""
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.delete(f"/admin/members/{env['users']['admin']}")
        assert resp.status_code == 400

    async def test_a_member_of_another_tenant_cannot_be_touched(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/members/{env['users']['outsider']}",
                json={"role_slug": "viewer"},
            )
        assert resp.status_code == 404


class TestPlatformSurface:
    async def test_only_a_platform_admin_lists_organizations(self, env):
        org_admin = await _principal_for(env, "admin")
        async with _client(org_admin) as c:
            resp = await c.get("/admin/orgs")
        assert resp.status_code == 403, "an org admin must not enumerate tenants"

        platform = await _principal_for(env, "platform")
        async with _client(platform) as c:
            resp = await c.get("/admin/orgs")
        assert resp.status_code == 200
        assert {o["slug"] for o in resp.json()} >= {"acme", "globex"}

    async def test_org_admin_cannot_create_a_tenant(self, env):
        org_admin = await _principal_for(env, "admin")
        async with _client(org_admin) as c:
            resp = await c.post("/admin/orgs", json={"name": "New", "slug": "new"})
        assert resp.status_code == 403


class TestQuotasAndOverview:
    async def test_quota_round_trip_reports_live_usage(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.put("/admin/quotas", json={"max_users": 5})
            assert resp.status_code == 200, resp.text
            body = resp.json()
        assert body["max_users"] == 5
        assert body["used_users"] == 2, "Acme has two members"

    async def test_seat_quota_refuses_the_next_member(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            await c.put("/admin/quotas", json={"max_users": 2})
            resp = await c.post(
                "/admin/members",
                json={"user_id": env["users"]["platform"], "role_slug": "viewer"},
            )
        assert resp.status_code == 409
        assert "Seat quota" in resp.json()["detail"]

    async def test_overview_is_scoped_and_shaped(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.get("/admin/overview")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["org_name"] == "Acme"
        assert body["users_total"] == 2
        assert body["projects_total"] == 0
        assert len(body["runs_by_day"]) == 8
        assert body["quota"]["used_users"] == 2
