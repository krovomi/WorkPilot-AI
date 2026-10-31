"""Server mode: groups of people, and what their members inherit.

A group lives in one organization. Its members get its organization role on
top of their own, and its role on the projects it is given, the highest of
their own and their groups' winning. Nothing crosses a tenant: a person,
group, role or project of another organization answers 404, and a person who
leaves the organization stops inheriting anything from its groups.
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
        "sqlite+aiosqlite:///" + str(tmp_path / "groups.sqlite3").replace("\\", "/"),
    )
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


@pytest_asyncio.fixture()
async def env(tmp_path):
    """Two tenants. Acme: an admin, a viewer (vic) and a project; Globex: its
    admin and a project of its own."""
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()

    from server.db.models import Organization, OrgMember, Project, Role, User
    from sqlalchemy import select

    async with db_engine.get_session_factory()() as db:
        acme = Organization(id=str(uuid.uuid4()), name="Acme", slug="acme")
        globex = Organization(id=str(uuid.uuid4()), name="Globex", slug="globex")
        db.add_all([acme, globex])
        users = {}
        for key in ("admin", "vic", "outsider"):
            users[key] = User(
                id=str(uuid.uuid4()), email=f"{key}@x.test", display_name=key
            )
            db.add(users[key])
        await db.flush()
        roles = dict(
            (await db.execute(select(Role.slug, Role.id).where(Role.org_id.is_(None))))
            .tuples()
            .all()
        )
        db.add_all(
            [
                OrgMember(
                    org_id=acme.id, user_id=users["admin"].id, role_id=roles["admin"]
                ),
                OrgMember(
                    org_id=acme.id, user_id=users["vic"].id, role_id=roles["viewer"]
                ),
                OrgMember(
                    org_id=globex.id,
                    user_id=users["outsider"].id,
                    role_id=roles["admin"],
                ),
            ]
        )
        shop = Project(
            org_id=acme.id,
            name="Shop",
            repo_url="https://x/s.git",
            server_path=str(tmp_path),
        )
        other = Project(
            org_id=globex.id,
            name="Other",
            repo_url="https://x/o.git",
            server_path=str(tmp_path),
        )
        db.add_all([shop, other])
        await db.commit()
        yield {
            "acme": acme.id,
            "globex": globex.id,
            "users": {k: v.id for k, v in users.items()},
            "shop": shop.id,
            "other": other.id,
        }
    await db_engine.dispose_engine()


async def _principal(env, key: str, org_key: str = "acme"):
    from server.authz.engine import resolve_permissions
    from server.authz.principal import Principal
    from server.db.engine import get_session_factory
    from server.db.models import User

    user_id = env["users"][key]
    async with get_session_factory()() as db:
        user = await db.get(User, user_id)
        perms, slug = await resolve_permissions(
            db, user_id=user_id, platform_role=user.role, org_id=env[org_key]
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


def _client(principal) -> AsyncClient:
    from server.routers.admin import router

    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        request.state.org_id = principal.org_id
        return await call_next(request)

    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _project_role(env, key: str, project: str):
    from server.auth.deps import CurrentUser, get_project_role
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        user = CurrentUser(
            id=env["users"][key], email="", display_name="", role="member"
        )
        return await get_project_role(db, user, env[project], org_id=env["acme"])


async def test_members_inherit_the_groups_org_role_and_project_role(env):
    vic = env["users"]["vic"]
    before = await _principal(env, "vic")
    assert "task.merge" not in before.permissions
    assert await _project_role(env, "vic", "shop") is None

    async with _client(await _principal(env, "admin")) as c:
        created = await c.post(
            "/admin/groups", json={"name": "Release", "role_slug": "maintainer"}
        )
        assert created.status_code == 201, created.text
        gid = created.json()["id"]
        r = await c.put(f"/admin/groups/{gid}/members/{vic}")
        assert [m["user_id"] for m in r.json()["members"]] == [vic]
        r = await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "member"}
        )
        assert r.json()["projects"] == [
            {"project_id": env["shop"], "name": "Shop", "role": "member"}
        ]
        listed = (await c.get("/admin/groups")).json()
        assert [g["role_slug"] for g in listed] == ["maintainer"]

    after = await _principal(env, "vic")
    assert "task.merge" in after.permissions  # from the group's maintainer role
    assert after.org_role_slug == "viewer"  # their own role is unchanged
    assert await _project_role(env, "vic", "shop") == "member"


async def test_the_highest_project_role_wins_and_the_project_is_listed(env):
    from server.authz.scope import load_project_scope
    from server.db.engine import get_session_factory
    from server.db.models import ProjectMember

    vic = env["users"]["vic"]
    async with get_session_factory()() as db:
        db.add(ProjectMember(project_id=env["shop"], user_id=vic, role="owner"))
        await db.commit()
    async with _client(await _principal(env, "admin")) as c:
        gid = (await c.post("/admin/groups", json={"name": "Readers"})).json()["id"]
        await c.put(f"/admin/groups/{gid}/members/{vic}")
        await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "viewer"}
        )
    # Own "owner" beats the group's "viewer": a group never lowers anyone.
    assert await _project_role(env, "vic", "shop") == "owner"
    async with get_session_factory()() as db:
        scope = await load_project_scope(db, await _principal(env, "vic"), env["shop"])
    assert scope.project_role == "owner"


async def test_a_project_reached_through_a_group_is_listed(env):
    from server.routers.projects import router as projects_router

    vic = env["users"]["vic"]
    async with _client(await _principal(env, "admin")) as c:
        gid = (await c.post("/admin/groups", json={"name": "Front"})).json()["id"]
        await c.put(f"/admin/groups/{gid}/members/{vic}")
        await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "member"}
        )

    from server.auth.deps import CurrentUser, get_current_user

    principal = await _principal(env, "vic")
    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        request.state.org_id = principal.org_id
        return await call_next(request)

    app.include_router(projects_router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id=vic, email="vic@x.test", display_name="vic", role="member"
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        listed = (await c.get("/projects")).json()
    assert [(p["id"], p["my_role"]) for p in listed] == [(env["shop"], "member")]


async def test_nothing_crosses_a_tenant(env):
    outsider = env["users"]["outsider"]
    async with _client(await _principal(env, "admin")) as c:
        gid = (await c.post("/admin/groups", json={"name": "QA"})).json()["id"]
        assert (
            await c.put(f"/admin/groups/{gid}/members/{outsider}")
        ).status_code == 404
        r = await c.put(
            f"/admin/groups/{gid}/projects/{env['other']}", json={"role": "owner"}
        )
        assert r.status_code == 404

    async with _client(await _principal(env, "outsider", "globex")) as c:
        assert (await c.get("/admin/groups")).json() == []
        assert (
            await c.patch(f"/admin/groups/{gid}", json={"name": "Mine"})
        ).status_code == 404
        assert (await c.delete(f"/admin/groups/{gid}")).status_code == 404
        r = await c.put(f"/admin/groups/{gid}/members/{outsider}")
        assert r.status_code == 404


async def test_managing_groups_needs_the_rights_that_hand_out_access(env):
    async with _client(await _principal(env, "admin")) as c:
        gid = (await c.post("/admin/groups", json={"name": "QA"})).json()["id"]
    async with _client(await _principal(env, "vic")) as c:
        assert (await c.get("/admin/groups")).status_code == 200
        denied = await c.post("/admin/groups", json={"name": "Mine"})
        assert (
            denied.status_code == 403 and "org.member.write" in denied.json()["detail"]
        )
        vic = env["users"]["vic"]
        assert (await c.put(f"/admin/groups/{gid}/members/{vic}")).status_code == 403
        r = await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "owner"}
        )
        assert r.status_code == 403 and "project.member.write" in r.json()["detail"]


async def test_leaving_the_organization_ends_what_its_groups_gave(env):
    vic = env["users"]["vic"]
    async with _client(await _principal(env, "admin")) as c:
        gid = (
            await c.post(
                "/admin/groups", json={"name": "Ops", "role_slug": "maintainer"}
            )
        ).json()["id"]
        await c.put(f"/admin/groups/{gid}/members/{vic}")
        await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "owner"}
        )
        assert (await c.delete(f"/admin/members/{vic}")).status_code == 200
        group = (await c.get("/admin/groups")).json()[0]
    assert group["members"] == []
    assert (await _principal(env, "vic")).permissions == frozenset()
    assert await _project_role(env, "vic", "shop") is None


async def test_names_roles_and_project_roles_are_checked(env):
    async with _client(await _principal(env, "admin")) as c:
        assert (await c.post("/admin/groups", json={"name": "QA"})).status_code == 201
        assert (await c.post("/admin/groups", json={"name": "QA"})).status_code == 409
        bad_role = await c.post(
            "/admin/groups", json={"name": "X", "role_slug": "nope"}
        )
        assert bad_role.status_code == 400
        gid = (await c.get("/admin/groups")).json()[0]["id"]
        r = await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "god"}
        )
        assert r.status_code == 400
        # "" takes the group's organization role away.
        await c.patch(f"/admin/groups/{gid}", json={"role_slug": "maintainer"})
        r = await c.patch(f"/admin/groups/{gid}", json={"role_slug": ""})
        assert r.json()["role_slug"] is None
        assert (await c.delete(f"/admin/groups/{gid}")).json() == {"deleted": True}
        assert (await c.get("/admin/groups")).json() == []


async def test_every_change_is_audited(env):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    vic = env["users"]["vic"]
    async with _client(await _principal(env, "admin")) as c:
        gid = (await c.post("/admin/groups", json={"name": "QA"})).json()["id"]
        await c.put(f"/admin/groups/{gid}/members/{vic}")
        await c.put(
            f"/admin/groups/{gid}/projects/{env['shop']}", json={"role": "member"}
        )
        await c.delete(f"/admin/groups/{gid}/projects/{env['shop']}")
        await c.delete(f"/admin/groups/{gid}/members/{vic}")
        await c.delete(f"/admin/groups/{gid}")
    async with get_session_factory()() as db:
        actions = list(await db.scalars(select(AuditLog.action)))
    # Compared as a set of rows: timestamps may tie on a coarse clock.
    assert sorted(actions) == sorted(
        [
            "org.group.created",
            "org.group.member_added",
            "project.group.role_set",
            "project.group.removed",
            "org.group.member_removed",
            "org.group.deleted",
        ]
    )
