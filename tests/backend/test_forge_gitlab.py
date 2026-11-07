"""Server mode: GitLab for a server project, with the caller's own token.

The app's GitLab views send their calls to the server for a server project.
These tests hold the relay to an instance the operator named (a project's
URL alone never sends a token anywhere), to the project, to the calls the
views make, rebuilt rather than copied, and to the caller's own token.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_ADA_TOKEN = "glpat-" + "A" * 20  # pragma: allowlist secret


@pytest.fixture
async def server(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv("WORKPILOT_GITLAB_HOSTS", "git.acme.test, not a host")
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "gitlab.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User
    from server.services.secrets import set_user_secret

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "repos" / "shop"
    clone.mkdir(parents=True)
    async with db_engine.get_session_factory()() as db:
        db.add_all(
            [
                User(id="u-ada", email="ada@x.test", display_name="Ada"),
                User(id="u-eve", email="eve@x.test", display_name="Eve"),
            ]
        )
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        projects = [
            Project(
                org_id=org.id,
                name=name,
                repo_url=url,
                server_path=str(clone),
            )
            for name, url in (
                ("Shop", "https://git.acme.test/team/web/shop.git"),
                ("Elsewhere", "https://evil.test/team/shop.git"),
            )
        ]
        db.add_all(projects)
        await db.commit()
        await set_user_secret(db, "u-ada", "gitlab_token", _ADA_TOKEN)
        ids = (projects[0].id, projects[1].id, org.id)

    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json=[{"iid": 1}], headers={"X-Total": "42"})

    from shared_features import forge

    real = httpx.AsyncClient

    def client(**kwargs):
        return real(transport=httpx.MockTransport(answer), **kwargs)

    monkeypatch.setattr(forge.httpx, "AsyncClient", client)
    yield {"ids": ids, "clone": clone, "sent": sent}
    server_config.reset_settings_cache()


def _scope(server, role="member", which=0):
    from server.authz.scope import ProjectScope

    project_id, other_id, org_id = server["ids"]
    return ProjectScope([project_id, other_id][which], org_id, server["clone"], role)


def _request(user_id: str, *permissions: str):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(
        id=user_id, email=f"{user_id}@x.test", permissions=frozenset(permissions)
    )
    return request


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


ENC = "/projects/team%2Fweb%2Fshop"


def test_a_gitlab_project_is_on_an_instance_the_operator_named(server):
    from server.forges import forge_of, gitlab_project

    assert server_config.get_settings().gitlab_hosts == ("gitlab.com", "git.acme.test")
    assert gitlab_project("https://gitlab.com/a/b.git") == ("gitlab.com", "a/b")
    assert gitlab_project("git@git.acme.test:team/web/shop.git") == (
        "git.acme.test",
        "team/web/shop",
    )
    assert gitlab_project("https://GIT.ACME.TEST/team/shop") == (
        "git.acme.test",
        "team/shop",
    )
    for refused in (
        "https://evil.test/team/shop.git",
        "https://169.254.169.254/latest/meta",
        "https://git.acme.test.evil.test/team/shop",
        "https://git.acme.test/team/../shop",
        "https://git.acme.test/shop",
        "https://git.acme.test/team/.git",
        "http://git.acme.test/team/shop",
    ):
        assert gitlab_project(refused) is None, refused
    assert forge_of("https://github.com/acme/shop.git") == "github"
    assert forge_of("https://gitlab.com/acme/shop.git") == "gitlab"
    assert forge_of("https://evil.test/acme/shop.git") is None


def test_a_project_s_listing_says_its_forge(server):
    from server.schemas import ProjectPublic

    def listed(url: str) -> str | None:
        return ProjectPublic(
            id="p",
            name="P",
            repo_url=url,
            default_branch="main",
            created_by=None,
            created_at=datetime.now(UTC),
        ).model_dump()["forge"]

    assert listed("https://github.com/acme/shop.git") == "github"
    assert listed("https://git.acme.test/team/shop.git") == "gitlab"
    assert listed("https://evil.test/team/shop.git") is None


def test_only_the_views_calls_on_the_project_are_made():
    from shared_features.forge_gitlab import gitlab_call

    path = "team/web/shop"
    for method, endpoint, sent, params in (
        ("GET", ENC, ENC, {}),
        (
            "GET",
            f"{ENC}/issues?state=opened&per_page=100&order_by=updated_at&sort=desc",
            f"{ENC}/issues",
            {
                "state": "opened",
                "per_page": "100",
                "order_by": "updated_at",
                "sort": "desc",
            },
        ),
        ("GET", f"{ENC}/issues/3/notes", None, {}),
        ("GET", f"{ENC}/merge_requests/3/changes", None, {}),
        (
            "GET",
            "/projects/TEAM%2Fweb%2Fshop/merge_requests/3",
            f"{ENC}/merge_requests/3",
            {},
        ),
        ("GET", "/user", "/user", {}),
        ("POST", f"{ENC}/merge_requests", None, {}),
        ("POST", f"{ENC}/merge_requests/3/notes", None, {}),
        ("POST", f"{ENC}/merge_requests/3/approve", None, {}),
        ("PUT", f"{ENC}/merge_requests/3", None, {}),
        ("PUT", f"{ENC}/merge_requests/3/merge", None, {}),
        ("PUT", f"{ENC}/merge_requests/3/rebase", None, {}),
    ):
        found = gitlab_call(method, endpoint, path)
        assert found is not None, endpoint
        assert found[0] == (sent or endpoint), endpoint
        assert found[1] == params, endpoint
    for method, refused in (
        ("GET", "/projects/team%2Fweb%2Fother/issues"),
        ("GET", "/projects/team%2Fweb%2Fshop2/issues"),
        ("GET", "/projects/42/issues"),
        ("GET", f"{ENC}/../other/issues"),
        ("GET", f"{ENC}/repository/files/x"),
        ("GET", f"{ENC}/issues?search=x"),
        ("GET", f"{ENC}/issues/3x"),
        ("GET", "//evil.test/api/v4/projects"),
        ("GET", "/projects?membership=true"),
        ("POST", f"{ENC}/merge_requests?x=1"),
        ("DELETE", ENC),
        ("PUT", f"{ENC}/variables/X"),
        ("POST", "/user"),
    ):
        assert gitlab_call(method, refused, path) is None, refused


@pytest.mark.asyncio
async def test_a_read_goes_to_the_named_instance_with_the_caller_s_token(server):
    from shared_features.forge import RestCall
    from shared_features.forge_gitlab import gitlab_read

    async with await _db() as db:
        answer = await gitlab_read(
            RestCall(endpoint=f"{ENC}/issues?state=opened"),
            _request("u-ada", "vcs.read"),
            _scope(server, "viewer"),
            db,
        )
    assert answer == {"status": 200, "total": 42, "body": [{"iid": 1}]}
    (sent,) = server["sent"]
    assert str(sent.url) == (
        "https://git.acme.test/api/v4/projects/team%2Fweb%2Fshop/issues?state=opened"
    )
    assert sent.headers["PRIVATE-TOKEN"] == _ADA_TOKEN


@pytest.mark.asyncio
async def test_refusals(server):
    from shared_features.forge import RestCall
    from shared_features.forge_gitlab import gitlab_read, gitlab_write

    cases = [
        # A project whose URL names a host nobody vouched for: no call at all.
        (gitlab_read, RestCall(endpoint="/user"), "member", (), 1, 404),
        # Without their own token, nothing is sent.
        (gitlab_read, RestCall(endpoint=ENC), "member", (), 0, 412, "u-eve"),
        (gitlab_read, RestCall(method="POST", endpoint=ENC), "member", (), 0, 405),
        (
            gitlab_write,
            RestCall(method="POST", endpoint=f"{ENC}/merge_requests/3/notes", body={}),
            "viewer",
            ("vcs.write",),
            0,
            403,
        ),
        (
            gitlab_write,
            RestCall(method="POST", endpoint=f"{ENC}/merge_requests", body={}),
            "member",
            ("vcs.write",),
            0,
            403,
        ),
        (
            gitlab_write,
            RestCall(method="PUT", endpoint=f"{ENC}/merge_requests/3/merge", body={}),
            "member",
            ("vcs.write", "vcs.pr.create"),
            0,
            403,
        ),
        (
            gitlab_write,
            RestCall(method="DELETE", endpoint=ENC),
            "member",
            ("vcs.write", "vcs.pr.create", "vcs.pr.merge"),
            0,
            403,
        ),
    ]
    for route, call, role, permissions, which, status, *user in cases:
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await route(
                    call,
                    _request(user[0] if user else "u-ada", "vcs.read", *permissions),
                    _scope(server, role, which),
                    db,
                )
        assert refused.value.status_code == status, (route.__name__, call)
    assert server["sent"] == []


@pytest.mark.asyncio
async def test_a_member_comments_opens_and_a_merger_merges(server):
    from shared_features.forge import RestCall
    from shared_features.forge_gitlab import gitlab_write

    async with await _db() as db:
        for call, permissions in (
            (
                RestCall(
                    method="POST",
                    endpoint=f"{ENC}/merge_requests/3/notes",
                    body={"body": "hi"},
                ),
                ("vcs.write",),
            ),
            (
                RestCall(
                    method="POST", endpoint=f"{ENC}/merge_requests", body={"title": "x"}
                ),
                ("vcs.write", "vcs.pr.create"),
            ),
            (
                RestCall(
                    method="PUT", endpoint=f"{ENC}/merge_requests/3/merge", body={}
                ),
                ("vcs.write", "vcs.pr.merge"),
            ),
        ):
            await gitlab_write(
                call, _request("u-ada", *permissions), _scope(server), db
            )
    assert [(r.method, r.url.raw_path.decode()) for r in server["sent"]] == [
        ("POST", "/api/v4/projects/team%2Fweb%2Fshop/merge_requests/3/notes"),
        ("POST", "/api/v4/projects/team%2Fweb%2Fshop/merge_requests"),
        ("PUT", "/api/v4/projects/team%2Fweb%2Fshop/merge_requests/3/merge"),
    ]


@pytest.mark.asyncio
async def test_a_strict_offline_project_reaches_no_gitlab(server):
    import json

    from shared_features.forge import RestCall
    from shared_features.forge_gitlab import gitlab_read

    policy = server["clone"] / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir(parents=True)
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")
    async with await _db() as db:
        with pytest.raises(HTTPException) as refused:
            await gitlab_read(
                RestCall(endpoint=ENC),
                _request("u-ada", "vcs.read"),
                _scope(server),
                db,
            )
    assert refused.value.status_code == 409
    assert server["sent"] == []


def test_reads_need_read_writes_need_write():
    from server.authz.mounting import permission_for

    base = "/api/features/forge/gitlab"
    assert permission_for("POST", f"{base}/read", "vcs") == "vcs.read"
    assert permission_for("POST", f"{base}/write", "vcs") == "vcs.write"
