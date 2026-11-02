"""Access checks of the server's member directory, project members, org roles
and audit history.

Each test pins one rule: what the caller may list or change is bounded by the
organization they act in, a deactivated account stops working on its next
request, the organization always keeps someone who can manage it, and an
event about a project lands in that project's organization history.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from tests.backend.test_admin_api import (  # noqa: F401  (fixtures)
    _client,
    _principal_for,
    _settings,
)

pytestmark = pytest.mark.asyncio


def _bearer(user_id: str, role: str = "member") -> dict[str, str]:
    from types import SimpleNamespace

    from server.auth.jwt_tokens import create_access_token

    token, _ = create_access_token(
        SimpleNamespace(id=user_id, email="x@test", display_name="X", role=role)
    )
    return {"Authorization": f"Bearer {token}"}


def _app_with(router, org_id: str | None) -> AsyncClient:
    """`router` behind a middleware that sets the active organization."""
    app = FastAPI()

    @app.middleware("http")
    async def _org(request, call_next):
        request.state.org_id = org_id
        return await call_next(request)

    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _project(org_id: str, owner_id: str) -> str:
    from server.db.engine import get_session_factory
    from server.db.models import Project, ProjectMember

    async with get_session_factory()() as db:
        project = Project(
            org_id=org_id, name="P", repo_url="https://x/p.git", server_path="/tmp/p"
        )
        db.add(project)
        await db.flush()
        db.add(ProjectMember(project_id=project.id, user_id=owner_id, role="owner"))
        await db.commit()
        return project.id


class TestMemberDirectory:
    async def test_lists_only_the_active_organization(self, env):
        from server.routers.users import router

        async with _app_with(router, env["acme"]) as c:
            resp = await c.get("/users", headers=_bearer(env["users"]["viewer"]))
        assert resp.status_code == 200
        ids = {u["id"] for u in resp.json()}
        assert ids == {env["users"]["admin"], env["users"]["viewer"]}

    async def test_without_an_organization_lists_only_yourself(self, env):
        from server.routers.users import router

        async with _app_with(router, None) as c:
            resp = await c.get("/users", headers=_bearer(env["users"]["outsider"]))
        assert [u["id"] for u in resp.json()] == [env["users"]["outsider"]]

    async def test_a_platform_admin_sees_every_account(self, env):
        from server.routers.users import router

        async with _app_with(router, env["acme"]) as c:
            resp = await c.get(
                "/users", headers=_bearer(env["users"]["platform"], role="admin")
            )
        assert len(resp.json()) == 4


class TestProjectMembers:
    async def test_someone_of_another_organization_cannot_join(self, env):
        from server.routers.projects import router

        project_id = await _project(env["acme"], env["users"]["admin"])
        async with _app_with(router, env["acme"]) as c:
            resp = await c.post(
                f"/projects/{project_id}/members",
                json={"user_id": env["users"]["outsider"], "role": "member"},
                headers=_bearer(env["users"]["admin"]),
            )
        assert resp.status_code == 404

    async def test_a_member_of_the_organization_can_join(self, env):
        from server.routers.projects import router

        project_id = await _project(env["acme"], env["users"]["admin"])
        async with _app_with(router, env["acme"]) as c:
            resp = await c.post(
                f"/projects/{project_id}/members",
                json={"user_id": env["users"]["viewer"], "role": "viewer"},
                headers=_bearer(env["users"]["admin"]),
            )
        assert resp.status_code == 201


class TestAuditHistory:
    async def test_a_project_event_is_filed_under_its_organization(self, env):
        from server.db.engine import get_session_factory
        from server.db.models import AuditLog

        project_id = await _project(env["acme"], env["users"]["admin"])
        async with get_session_factory()() as db:
            row = AuditLog(
                user_id=env["users"]["admin"],
                project_id=project_id,
                action="spec.claimed",
            )
            db.add(row)
            await db.commit()
            assert row.org_id == env["acme"]


class TestOrgRoles:
    async def test_cannot_demote_yourself(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/members/{env['users']['admin']}",
                json={"role_slug": "viewer"},
            )
        assert resp.status_code == 400

    async def test_cannot_demote_the_last_member_who_manages_the_organization(
        self, env
    ):
        # A platform operator acting in acme, where `admin` is the only admin.
        principal = await _principal_for(env, "platform")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/members/{env['users']['admin']}",
                json={"role_slug": "viewer"},
            )
        assert resp.status_code == 400
        assert "without an administrator" in resp.json()["detail"]

    async def test_another_member_can_still_be_demoted(self, env):
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            promote = await c.patch(
                f"/admin/members/{env['users']['viewer']}",
                json={"role_slug": "admin"},
            )
            demote = await c.patch(
                f"/admin/members/{env['users']['viewer']}",
                json={"role_slug": "viewer"},
            )
        assert (promote.status_code, demote.status_code) == (200, 200)

    async def test_a_project_scoped_role_is_not_an_organization_role(self, env):
        from server.db.engine import get_session_factory
        from server.db.models import Role

        async with get_session_factory()() as db:
            db.add(
                Role(
                    id=str(uuid.uuid4()),
                    org_id=env["acme"],
                    slug="proj-only",
                    name="Project only",
                    scope="project",
                    permissions=["task.read"],
                )
            )
            await db.commit()
        principal = await _principal_for(env, "admin")
        async with _client(principal) as c:
            resp = await c.patch(
                f"/admin/members/{env['users']['viewer']}",
                json={"role_slug": "proj-only"},
            )
        assert resp.status_code == 400


class TestDeactivation:
    async def test_a_deactivated_account_is_refused_on_its_next_request(self, env):
        from server import integration
        from server.db.engine import get_session_factory
        from server.db.models import User
        from starlette.requests import Request

        user_id = env["users"]["viewer"]
        claims = {"sub": user_id, "role": "member"}
        request = Request({"type": "http", "headers": [], "state": {}})
        assert await integration._attach_principal(request, claims) is True

        async with get_session_factory()() as db:
            (await db.get(User, user_id)).is_active = False
            await db.commit()

        request = Request({"type": "http", "headers": [], "state": {}})
        assert await integration._attach_principal(request, claims) is False


def _app_as(router, principal) -> AsyncClient:
    """`router` with `principal` resolved, as the auth middleware leaves it."""
    app = FastAPI()

    @app.middleware("http")
    async def _inject(request, call_next):
        request.state.principal = principal
        request.state.org_id = principal.org_id
        return await call_next(request)

    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _spec_of_a_project_the_viewer_works_on(env) -> tuple[str, str]:
    """A project of acme where `viewer` is a project member, and one spec."""
    from server.db.engine import get_session_factory
    from server.db.models import ProjectMember, SpecIndex

    project_id = await _project(env["acme"], env["users"]["admin"])
    async with get_session_factory()() as db:
        db.add(
            ProjectMember(
                project_id=project_id, user_id=env["users"]["viewer"], role="member"
            )
        )
        spec = SpecIndex(project_id=project_id, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        return project_id, spec.id


class TestWhatTheOrganizationRoleAllows:
    """Project membership says where someone works; their organization role
    says what they may do there."""

    async def test_a_reader_cannot_register_a_project(self, env):
        from server.routers.projects import router

        principal = await _principal_for(env, "viewer")
        async with _app_as(router, principal) as c:
            resp = await c.post(
                "/projects",
                json={"name": "P", "repo_url": "https://example.test/p.git"},
                headers=_bearer(env["users"]["viewer"]),
            )
        assert resp.status_code == 403

    async def test_who_may_add_to_the_board_may_register_one(self, env, monkeypatch):
        from server.routers import projects
        from server.services.repos import RepoError

        async def _no_clone(*_a):
            raise RepoError("not cloned in tests")

        monkeypatch.setattr(projects, "clone_project", _no_clone)
        principal = await _principal_for(env, "admin")
        async with _app_as(projects.router, principal) as c:
            resp = await c.post(
                "/projects",
                json={"name": "P", "repo_url": "https://example.test/p.git"},
                headers=_bearer(env["users"]["admin"]),
            )
        # Past the permission, stopped by the clone.
        assert resp.status_code == 400

    @pytest.mark.parametrize(
        "path", ["/claim", "/release", "/runs/r1/cancel"], ids=lambda p: p
    )
    async def test_a_reader_of_the_project_cannot_claim_release_or_cancel(
        self, env, path
    ):
        from server.routers.specs import router

        project_id, spec_id = await _spec_of_a_project_the_viewer_works_on(env)
        principal = await _principal_for(env, "viewer")
        async with _app_as(router, principal) as c:
            resp = await c.post(
                f"/projects/{project_id}/specs/{spec_id}{path}",
                json={},
                headers=_bearer(env["users"]["viewer"]),
            )
        assert resp.status_code == 403

    async def test_a_suspended_organization_cannot_claim(self, env):
        from server.db.engine import get_session_factory
        from server.db.models import Organization
        from server.routers.specs import router

        project_id, spec_id = await _spec_of_a_project_the_viewer_works_on(env)
        async with get_session_factory()() as db:
            (await db.get(Organization, env["acme"])).is_active = False
            await db.commit()
        principal = await _principal_for(env, "admin")
        async with _app_as(router, principal) as c:
            resp = await c.post(
                f"/projects/{project_id}/specs/{spec_id}/claim",
                json={},
                headers=_bearer(env["users"]["admin"]),
            )
        assert resp.status_code == 403

    async def test_a_contributor_still_claims(self, env):
        from server.routers.specs import router

        project_id, spec_id = await _spec_of_a_project_the_viewer_works_on(env)
        principal = await _principal_for(env, "admin")
        async with _app_as(router, principal) as c:
            resp = await c.post(
                f"/projects/{project_id}/specs/{spec_id}/claim",
                json={},
                headers=_bearer(env["users"]["admin"]),
            )
        assert resp.status_code == 200, resp.text
