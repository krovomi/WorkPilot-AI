"""A server-mode deployment for the route tests: app, database, people, projects.

``build_app`` assembles what ``provider_api`` serves in server mode: the bearer
middleware and the server routers (``server.integration.mount_server_mode``),
then every project feature mounted through ``mount_served``, the guard
``provider_api._mount`` uses, and liveness. The local-only routers are left
out: a server answers 404 on them (``tests/backend/test_server_served_features.py``).

``seed`` writes two organizations, the people of each with their organization
role, a group, and one project per organization whose clone is a real git
repository. Tokens are minted by the server's own signer, so every request
goes through the real middleware: signature, tenant, permissions, path keys.
"""

from __future__ import annotations

import os
import secrets
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

#: key → (organization, organization role, platform role, role on its
#: organization's project). ``None`` for the project role: not a member.
PEOPLE: dict[str, tuple[str | None, str | None, str, str | None]] = {
    # Operates the deployment; belongs to no organization.
    "platform": (None, None, "admin", None),
    "owner_a": ("a", "owner", "member", "owner"),
    # Administers the organization without being a member of its project.
    "admin_a": ("a", "admin", "member", None),
    "maintainer_a": ("a", "maintainer", "member", "owner"),
    "contributor_a": ("a", "contributor", "member", "member"),
    "reviewer_a": ("a", "reviewer", "member", "member"),
    "operator_a": ("a", "operator", "member", "member"),
    "analyst_a": ("a", "analyst", "member", "viewer"),
    "viewer_a": ("a", "viewer", "member", "viewer"),
    # A member of the project whose custom role grants nothing.
    "nobody_a": ("a", "nobody", "member", "member"),
    # A contributor of the organization who is not on the project.
    "stranger_a": ("a", "contributor", "member", None),
    # A viewer who gets contributor rights and the project from a group.
    "grouped_a": ("a", "viewer", "member", None),
    "admin_b": ("b", "admin", "member", "owner"),
    "member_b": ("b", "contributor", "member", "member"),
}

ORGS = {"a": ("Acme", "acme"), "b": ("Globex", "globex")}

JWT_SECRET = "route-tests-" + "s" * 40  # pragma: allowlist secret


def git(*args: str, cwd: Path) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Route Tests",
            "-c",
            "user.email=routes@example.test",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def make_repo(path: Path) -> Path:
    """A git repository with one commit on ``main``."""
    path.mkdir(parents=True, exist_ok=True)
    git("init", "-q", cwd=path)
    (path / "README.md").write_text("# Project\n", encoding="utf-8")
    git("add", "README.md", cwd=path)
    git("commit", "-q", "-m", "init", cwd=path)
    return path


def server_env(tmp: Path) -> dict[str, str]:
    db = str(tmp / "server.sqlite3").replace("\\", "/")
    return {
        "WORKPILOT_SERVER_MODE": "1",
        "WORKPILOT_JWT_SECRET": JWT_SECRET,
        "WORKPILOT_DATABASE_URL": f"sqlite+aiosqlite:///{db}",
        "WORKPILOT_REPOS_ROOT": str(tmp / "repos"),
        "WORKPILOT_DATA_DIR": str(tmp / "data"),
    }


def build_app() -> FastAPI:
    """The server-mode app ``provider_api`` builds, minus the local routers."""
    from server.authz.mounting import mount_served
    from server.integration import mount_server_mode
    from server.ratelimit import limiter
    from shared_features import mount_all
    from slowapi import _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    assert mount_server_mode(app), "server mode did not mount"
    mount_all(lambda router, feature: mount_served(app, router, feature))

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


@dataclass
class World:
    app: FastAPI
    tmp: Path
    orgs: dict[str, str]
    users: dict[str, str]
    projects: dict[str, str]
    roles: dict[str, str]
    group: str
    _client: httpx.AsyncClient | None = None
    tokens: dict[str, str] = field(default_factory=dict)

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app),
                base_url="http://server.test",
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    def clone(self, side: str) -> Path:
        return self.tmp / "repos" / self.projects[side]

    async def token(self, who: str, org: str | None = None) -> str:
        """An access token the server signed for ``who``, bound to its org."""
        from server.auth.jwt_tokens import create_access_token
        from server.db.engine import get_session_factory
        from server.db.models import User

        key = f"{who}@{org}"
        if key not in self.tokens:
            async with get_session_factory()() as db:
                user = await db.get(User, self.users[who])
            org_side = org if org is not None else PEOPLE[who][0]
            org_id = self.orgs[org_side] if org_side else None
            self.tokens[key] = create_access_token(user, org_id=org_id)[0]
        return self.tokens[key]

    async def give_password(self, who: str) -> str:
        """Give ``who`` a local password (a fresh random one) and return it."""
        from server.auth.local import hash_password
        from server.db.engine import get_session_factory
        from server.db.models import IdentityProvider, UserIdentity

        password = secrets.token_urlsafe(18)
        async with get_session_factory()() as db:
            db.add(
                UserIdentity(
                    user_id=self.users[who],
                    provider=IdentityProvider.LOCAL.value,
                    subject=f"{who}@example.com",
                    password_hash=hash_password(password),
                )
            )
            await db.commit()
        return password

    async def call(
        self,
        who: str | None,
        method: str,
        path: str,
        *,
        org: str | None = None,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """``method path`` as ``who`` (``None``: no token at all)."""
        sent = dict(headers or {})
        if who is not None:
            sent["Authorization"] = f"Bearer {await self.token(who, org)}"
        return await self.client.request(method, path, headers=sent, **kwargs)

    async def ok(self, who: str, method: str, path: str, **kwargs: Any) -> Any:
        """The decoded body of a 2xx answer; fails with the body otherwise."""
        answer = await self.call(who, method, path, **kwargs)
        assert answer.is_success, (
            f"{method} {path} as {who}: {answer.status_code} {answer.text}"
        )
        return answer.json() if answer.content else None


async def seed(tmp: Path) -> World:
    """Two organizations, their people, a group and one project each."""
    from server.db.engine import get_session_factory, init_db
    from server.db.models import (
        GroupMember,
        Organization,
        OrgMember,
        Project,
        ProjectGroup,
        ProjectMember,
        Role,
        User,
        UserGroup,
    )
    from sqlalchemy import select

    await init_db()
    async with get_session_factory()() as db:
        orgs = {}
        for side, (name, slug) in ORGS.items():
            org = Organization(id=str(uuid.uuid4()), name=name, slug=slug)
            db.add(org)
            orgs[side] = org.id
        await db.flush()

        roles = {
            slug: rid
            for slug, rid in (
                await db.execute(
                    select(Role.slug, Role.id).where(Role.org_id.is_(None))
                )
            ).all()
        }
        nobody = Role(
            id=str(uuid.uuid4()),
            org_id=orgs["a"],
            slug="nobody",
            name="Nobody",
            scope="org",
            permissions=[],
        )
        db.add(nobody)
        roles["nobody"] = nobody.id

        users: dict[str, str] = {}
        for key, (_, _, platform_role, _) in PEOPLE.items():
            user = User(
                id=str(uuid.uuid4()),
                email=f"{key}@example.com",
                display_name=key,
                role=platform_role,
            )
            db.add(user)
            users[key] = user.id
        await db.flush()

        for key, (side, org_role, _, _) in PEOPLE.items():
            if side is not None:
                db.add(
                    OrgMember(
                        org_id=orgs[side], user_id=users[key], role_id=roles[org_role]
                    )
                )

        projects: dict[str, str] = {}
        for side in ORGS:
            pid = str(uuid.uuid4())
            path = make_repo(tmp / "repos" / pid)
            db.add(
                Project(
                    id=pid,
                    org_id=orgs[side],
                    name=f"Project {side.upper()}",
                    repo_url=f"https://git.example.test/{side}.git",
                    default_branch="main",
                    server_path=str(path),
                    created_by=users["owner_a" if side == "a" else "admin_b"],
                )
            )
            projects[side] = pid
        await db.flush()

        for key, (side, _, _, project_role) in PEOPLE.items():
            if side is not None and project_role is not None:
                db.add(
                    ProjectMember(
                        project_id=projects[side], user_id=users[key], role=project_role
                    )
                )

        group = UserGroup(
            id=str(uuid.uuid4()),
            org_id=orgs["a"],
            name="Devs",
            role_id=roles["contributor"],
        )
        db.add(group)
        await db.flush()
        db.add(GroupMember(group_id=group.id, user_id=users["grouped_a"]))
        db.add(ProjectGroup(project_id=projects["a"], group_id=group.id, role="member"))
        await db.commit()

    return World(
        app=build_app(),
        tmp=tmp,
        orgs=orgs,
        users=users,
        projects=projects,
        roles=roles,
        group=group.id,
    )


def clean_environment() -> list[str]:
    """Every ``WORKPILOT_`` variable of the caller's shell, to unset."""
    return [k for k in os.environ if k.startswith("WORKPILOT_")]
