"""Server mode: GitHub for a server project, with the caller's own token.

The app's GitHub views send their calls to the server for a server project.
These tests hold the relay to the project's own repository, to the token of
the person asking (never another's, never the deployment's), to reads for a
read and to its open pull requests for GraphQL, and to the project's offline
policy.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_ADA_TOKEN = "ghp_" + "A" * 36  # pragma: allowlist secret
_BOB_TOKEN = "ghp_" + "B" * 36  # pragma: allowlist secret


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
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "forge.sqlite3").replace("\\", "/"),
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
                User(id="u-bob", email="bob@x.test", display_name="Bob"),
                User(id="u-eve", email="eve@x.test", display_name="Eve"),
            ]
        )
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        project = Project(
            org_id=org.id,
            name="Shop",
            repo_url="https://github.com/acme/shop.git",
            server_path=str(clone),
        )
        other = Project(
            org_id=org.id,
            name="Docs",
            repo_url="https://gitlab.com/acme/docs.git",
            server_path=str(tmp_path / "repos" / "docs"),
        )
        db.add_all([project, other])
        await db.commit()
        await set_user_secret(db, "u-ada", "github_token", _ADA_TOKEN)
        await set_user_secret(db, "u-bob", "github_token", _BOB_TOKEN)
        ids = (project.id, other.id, org.id)

    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.headers.get("Accept", "").endswith("diff"):
            return httpx.Response(200, text="diff --git a/x b/x\n")
        return httpx.Response(200, json={"ok": True})

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


def test_the_repository_is_read_from_the_project_url():
    from shared_features.forge import github_repo

    assert github_repo("https://github.com/acme/shop.git") == "acme/shop"
    assert github_repo("https://github.com/acme/shop") == "acme/shop"
    assert github_repo("git@github.com:acme/shop.git") == "acme/shop"
    assert github_repo("https://token@github.com/acme/shop.git") == "acme/shop"
    assert github_repo("https://gitlab.com/acme/shop.git") is None
    assert github_repo("https://github.com.evil.test/acme/shop") is None


def test_only_the_views_calls_on_the_project_s_repository_are_made():
    from shared_features.forge import api_call

    sha = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"
    for method, endpoint, path, params in (
        ("GET", "/repos/acme/shop", "/repos/acme/shop", {}),
        (
            "GET",
            "/repos/acme/shop/issues?state=open&per_page=100&sort=updated&page=2",
            "/repos/acme/shop/issues",
            {"state": "open", "per_page": "100", "sort": "updated", "page": "2"},
        ),
        ("GET", "/repos/ACME/Shop/pulls/3/files", "/repos/acme/shop/pulls/3/files", {}),
        ("GET", f"/repos/acme/shop/commits/{sha}/status", None, {}),
        ("GET", f"/repos/acme/shop/compare/0a1b2c3...{sha}", None, {}),
        (
            "GET",
            "/repos/acme/shop/actions/runs?status=action_required",
            "/repos/acme/shop/actions/runs",
            {"status": "action_required"},
        ),
        ("GET", "/user", "/user", {}),
        ("POST", "/repos/acme/shop/issues/3/comments", None, {}),
        ("PUT", "/repos/acme/shop/pulls/3/merge", None, {}),
        ("PUT", "/repos/acme/shop/pulls/3/update-branch", None, {}),
        ("POST", "/repos/acme/shop/actions/runs/9/approve", None, {}),
    ):
        found = api_call(method, endpoint, "acme/shop")
        assert found is not None, endpoint
        assert found[0] == (path or endpoint), endpoint
        assert found[1] == params, endpoint
    # The path sent is the project's repository as the server knows it.
    assert api_call("GET", "/repos/ACME/SHOP", "acme/shop")[0] == "/repos/acme/shop"
    for method, refused in (
        ("GET", "/repos/acme/other/issues"),
        ("GET", "/repos/acme/shop-private/issues"),
        ("GET", "/repos/acme/shop/../other/issues"),
        ("GET", "/repos/acme/shop/%2e%2e/other"),
        ("GET", "//api.github.com/repos/acme/other"),
        ("GET", "https://evil.test/repos/acme/shop"),
        ("GET", "/orgs/acme/members"),
        ("GET", "/user/repos"),
        ("GET", "/repos/acme/shop/issues#x"),
        ("GET", "repos/acme/shop"),
        ("GET", "/repos/acme/shop/ issues"),
        ("GET", "/repos/acme/shop/issues/3x"),
        ("GET", "/repos/acme/shop/issues/٣"),
        ("GET", "/repos/acme/shop/commits/main/status"),
        ("GET", "/repos/acme/shop/compare/main...dev"),
        ("GET", "/repos/acme/shop/contents/README.md"),
        ("GET", "/repos/acme/shop/issues?state=open&state=closed"),
        ("GET", "/repos/acme/shop/issues?q=x"),
        ("GET", "/repos/acme/shop/issues?state=" + "x" * 101),
        ("POST", "/repos/acme/shop/issues/3/comments?x=1"),
        ("POST", "/user"),
        ("POST", "/repos/acme/shop/issues"),
        ("DELETE", "/repos/acme/shop"),
    ):
        assert api_call(method, refused, "acme/shop") is None, refused


@pytest.mark.asyncio
async def test_a_read_is_made_with_the_caller_s_own_token(server):
    from shared_features.forge import RestCall, github_read

    async with await _db() as db:
        answer = await github_read(
            RestCall(endpoint="/repos/acme/shop/issues?state=open"),
            _request("u-ada", "vcs.read"),
            _scope(server, "viewer"),
            db,
        )
    assert answer == {"status": 200, "body": {"ok": True}}
    (sent,) = server["sent"]
    assert str(sent.url) == "https://api.github.com/repos/acme/shop/issues?state=open"
    assert sent.headers["Authorization"] == f"Bearer {_ADA_TOKEN}"
    assert _ADA_TOKEN not in json.dumps(answer)

    async with await _db() as db:
        diff = await github_read(
            RestCall(endpoint="/repos/acme/shop/pulls/3", accept="diff"),
            _request("u-bob", "vcs.read"),
            _scope(server),
            db,
        )
    assert diff["text"].startswith("diff --git")
    assert server["sent"][1].headers["Authorization"] == f"Bearer {_BOB_TOKEN}"


@pytest.mark.asyncio
async def test_without_their_own_token_nothing_is_sent(server):
    from shared_features.forge import RestCall, github_read

    async with await _db() as db:
        with pytest.raises(HTTPException) as refused:
            await github_read(
                RestCall(endpoint="/repos/acme/shop"),
                _request("u-eve", "vcs.read"),
                _scope(server),
                db,
            )
    assert refused.value.status_code == 412
    assert server["sent"] == []


@pytest.mark.asyncio
async def test_refusals(server):
    from shared_features.forge import RestCall, github_read, github_write

    cases = [
        # A read route never changes anything.
        (
            github_read,
            RestCall(method="POST", endpoint="/repos/acme/shop/issues"),
            "member",
            405,
            (),
        ),
        # Another repository, or a project that is not on GitHub.
        (github_read, RestCall(endpoint="/repos/acme/other"), "member", 403, ()),
        # A viewer writes nothing.
        (
            github_write,
            RestCall(
                method="POST",
                endpoint="/repos/acme/shop/issues/3/comments",
                body={"body": "hi"},
            ),
            "viewer",
            403,
            ("vcs.write",),
        ),
        # Only the changes the views make: not any call of GitHub's API.
        *[
            (
                github_write,
                RestCall(method=method, endpoint=endpoint, body={}),
                "member",
                403,
                ("vcs.write", "vcs.pr.merge"),
            )
            for method, endpoint in (
                ("DELETE", "/repos/acme/shop"),
                ("PATCH", "/repos/acme/shop"),
                ("PATCH", "/repos/acme/shop/git/refs/heads/main"),
                ("POST", "/repos/acme/shop/merges"),
                ("PUT", "/repos/acme/shop/contents/README.md"),
                ("POST", "/repos/acme/shop/issues/3/comments?x=1"),
                ("DELETE", "/repos/acme/shop/issues/3/comments"),
            )
        ],
        # A merge is its own permission.
        (
            github_write,
            RestCall(method="PUT", endpoint="/repos/acme/shop/pulls/3/merge", body={}),
            "member",
            403,
            ("vcs.write",),
        ),
    ]
    for route, call, role, status, permissions in cases:
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await route(
                    call,
                    _request("u-ada", "vcs.read", *permissions),
                    _scope(server, role),
                    db,
                )
        assert refused.value.status_code == status, (route.__name__, call)
    async with await _db() as db:
        with pytest.raises(HTTPException) as refused:
            await github_read(
                RestCall(endpoint="/repos/acme/docs"),
                _request("u-ada", "vcs.read"),
                _scope(server, which=1),
                db,
            )
    assert refused.value.status_code == 404
    assert server["sent"] == []


@pytest.mark.asyncio
async def test_a_member_comments_and_a_merger_merges(server):
    from shared_features.forge import PullsPage, RestCall, github_pulls, github_write

    async with await _db() as db:
        await github_write(
            RestCall(
                method="POST",
                endpoint="/repos/acme/shop/issues/3/comments",
                body={"body": "hi"},
            ),
            _request("u-ada", "vcs.write"),
            _scope(server),
            db,
        )
        await github_write(
            RestCall(
                method="PUT",
                endpoint="/repos/acme/shop/pulls/3/merge",
                body={"merge_method": "squash"},
            ),
            _request("u-ada", "vcs.write", "vcs.pr.merge"),
            _scope(server),
            db,
        )
        await github_pulls(
            PullsPage(after="Y3Vyc29y"),
            _request("u-ada", "vcs.read"),
            _scope(server, "viewer"),
            db,
        )
    methods = [(r.method, r.url.path) for r in server["sent"]]
    assert methods == [
        ("POST", "/repos/acme/shop/issues/3/comments"),
        ("PUT", "/repos/acme/shop/pulls/3/merge"),
        ("POST", "/graphql"),
    ]
    sent = json.loads(server["sent"][2].content)
    # The query is the server's, on the project's repository.
    assert "mutation" not in sent["query"]
    assert sent["variables"] == {
        "owner": "acme",
        "repo": "shop",
        "first": 100,
        "after": "Y3Vyc29y",
    }


def test_the_pull_request_page_takes_nothing_but_a_page():
    from pydantic import ValidationError
    from shared_features.forge import PullsPage

    for extra in (
        {"query": "mutation { x }"},
        {"owner": "acme"},
        {"first": 101},
        {"first": 0},
        {"after": "x" * 201},
    ):
        with pytest.raises(ValidationError):
            PullsPage.model_validate(extra)


@pytest.mark.asyncio
async def test_a_strict_offline_project_reaches_no_forge(server):
    from shared_features.forge import RestCall, github_read

    policy = server["clone"] / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir(parents=True)
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")
    async with await _db() as db:
        with pytest.raises(HTTPException) as refused:
            await github_read(
                RestCall(endpoint="/repos/acme/shop"),
                _request("u-ada", "vcs.read"),
                _scope(server),
                db,
            )
    assert refused.value.status_code == 409
    assert server["sent"] == []


def test_reads_need_read_writes_need_write():
    from server.authz.catalog import domain_for_feature
    from server.authz.mounting import permission_for

    domain = domain_for_feature("forge")
    assert domain == "vcs"
    base = "/api/features/forge/github"
    assert permission_for("POST", f"{base}/read", domain) == "vcs.read"
    assert permission_for("POST", f"{base}/pulls", domain) == "vcs.read"
    assert permission_for("POST", f"{base}/write", domain) == "vcs.write"
