"""Server mode: the boards over MCP (``POST /mcp``) with personal access tokens.

What must hold: a token is made with an access token and works on ``/mcp``
only; an access token does not open ``/mcp``; a revoked or expired token, or
one whose person left the organization, is refused; each tool resolves its
``project_id`` inside the token's organization; a read token never writes;
a viewer never writes; a browser page (another ``Origin``) is refused; the
transport answers one JSON body per POST and 202 to a notification.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_SECRET = "m" * 48


@pytest.fixture(autouse=True)
def _server_mode(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "mcp.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from shared_board import mcp_http as mcp_router

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(
        mcp_router,
        "emit_board_event",
        lambda project_id, event, data: events.append((project_id, event)),
    )
    yield events
    server_config.reset_settings_cache()


async def _world(tmp_path: Path) -> dict:
    """alice (member) and vic (viewer) on PA in org A; bob owns PB in org B."""
    from server.db import engine as db_engine
    from server.db.models import (
        Organization,
        OrgMember,
        Project,
        ProjectMember,
        Role,
        User,
    )
    from sqlalchemy import select

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clones = {}
    for name in ("a", "b"):
        clone = tmp_path / f"clone-{name}"
        clone.mkdir()
        subprocess.run(["git", "init", "-q", str(clone)], check=True)
        clones[name] = clone
    async with db_engine.get_session_factory()() as db:
        contributor = await db.scalar(
            select(Role.id).where(Role.slug == "contributor", Role.org_id.is_(None))
        )
        org_a = Organization(name="A", slug="org-a")
        org_b = Organization(name="B", slug="org-b")
        db.add_all([org_a, org_b])
        await db.flush()
        people = {
            name: User(email=f"{name}@example.com", display_name=name.title())
            for name in ("alice", "vic", "bob")
        }
        db.add_all(people.values())
        await db.flush()
        for name, org in (("alice", org_a), ("vic", org_a), ("bob", org_b)):
            db.add(
                OrgMember(org_id=org.id, user_id=people[name].id, role_id=contributor)
            )
        pa = Project(
            org_id=org_a.id, name="PA", repo_url="x", server_path=str(clones["a"])
        )
        pb = Project(
            org_id=org_b.id, name="PB", repo_url="x", server_path=str(clones["b"])
        )
        db.add_all([pa, pb])
        await db.flush()
        db.add_all(
            [
                ProjectMember(
                    project_id=pa.id, user_id=people["alice"].id, role="member"
                ),
                ProjectMember(
                    project_id=pa.id, user_id=people["vic"].id, role="viewer"
                ),
                ProjectMember(project_id=pb.id, user_id=people["bob"].id, role="owner"),
            ]
        )
        await db.commit()
        return {
            "org_a": org_a.id,
            "org_b": org_b.id,
            "pa": pa.id,
            "pb": pb.id,
            "clone_a": clones["a"],
            "users": {name: user for name, user in people.items()},
        }


@pytest.fixture
def stack(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from server.auth.jwt_tokens import create_access_token
    from server.integration import mount_server_mode
    from server.ratelimit import limiter

    world = asyncio.run(_world(tmp_path))
    app = FastAPI()
    app.state.limiter = limiter
    assert mount_server_mode(app)
    from server.authz.mounting import mount_served
    from shared_board.mcp_http import router as mcp_http_router

    # As provider_api mounts the board's routers, guard included.
    mount_served(app, mcp_http_router, "board")

    def jwt(name: str, org: str = "org_a") -> dict[str, str]:
        token, _ = create_access_token(world["users"][name], org_id=world[org])
        return {"Authorization": f"Bearer {token}"}

    with TestClient(app) as client:

        def pat(name: str, scope: str = "write", org: str = "org_a") -> str:
            res = client.post(
                "/users/me/access-tokens",
                json={"name": f"{name} laptop", "scope": scope},
                headers=jwt(name, org),
            )
            assert res.status_code == 201, res.text
            return res.json()["token"]

        yield client, world, jwt, pat


def _rpc(client, token: str | None, method: str, params: dict | None = None, **headers):
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post("/mcp", json=body, headers=headers)


def _tool(client, token: str, name: str, **arguments):
    res = _rpc(client, token, "tools/call", {"name": name, "arguments": arguments})
    assert res.status_code == 200, res.text
    result = res.json()["result"]
    text = result["content"][0]["text"]
    try:
        value = json.loads(text)
    except ValueError:
        value = text
    return value, result["isError"]


class TestTokens:
    def test_made_shown_once_listed_without_it_and_revoked(self, stack):
        client, world, jwt, pat = stack
        raw = pat("alice", "read")
        assert raw.startswith("wpat_")
        listed = client.get("/users/me/access-tokens", headers=jwt("alice")).json()
        assert len(listed) == 1
        assert "token" not in listed[0] and listed[0]["scope"] == "read"
        assert raw.startswith(listed[0]["prefix"])
        assert listed[0]["org_id"] == world["org_a"]

        res = client.delete(
            f"/users/me/access-tokens/{listed[0]['id']}", headers=jwt("alice")
        )
        assert res.status_code == 200
        assert _rpc(client, raw, "tools/list").status_code == 401
        assert client.get("/users/me/access-tokens", headers=jwt("alice")).json() == []

    def test_only_the_owner_revokes(self, stack):
        client, _, jwt, pat = stack
        pat("alice")
        token_id = client.get("/users/me/access-tokens", headers=jwt("alice")).json()[
            0
        ]["id"]
        res = client.delete(f"/users/me/access-tokens/{token_id}", headers=jwt("vic"))
        assert res.status_code == 404

    def test_a_personal_token_opens_mcp_and_nothing_else(self, stack):
        client, _, _, pat = stack
        raw = pat("alice")
        headers = {"Authorization": f"Bearer {raw}"}
        assert client.get("/projects", headers=headers).status_code == 401
        made = client.post(
            "/users/me/access-tokens", json={"name": "again"}, headers=headers
        )
        assert made.status_code == 401

    def test_an_access_token_does_not_open_mcp(self, stack):
        client, _, jwt, _ = stack
        res = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers=jwt("alice"),
        )
        assert res.status_code == 401
        assert res.headers["www-authenticate"].startswith("Bearer")

    def test_an_expired_token_is_refused(self, stack):
        client, _, _, pat = stack
        raw = pat("alice")

        async def expire():
            from server.db.engine import get_session_factory
            from server.db.models import AccessToken
            from sqlalchemy import update

            async with get_session_factory()() as db:
                await db.execute(
                    update(AccessToken).values(
                        expires_at=datetime.now(UTC) - timedelta(days=1)
                    )
                )
                await db.commit()

        asyncio.run(expire())
        assert _rpc(client, raw, "tools/list").status_code == 401

    def test_leaving_the_organization_ends_the_token(self, stack):
        client, world, _, pat = stack
        raw = pat("alice")

        async def leave():
            from server.db.engine import get_session_factory
            from server.db.models import OrgMember
            from sqlalchemy import delete

            async with get_session_factory()() as db:
                await db.execute(
                    delete(OrgMember).where(
                        OrgMember.user_id == world["users"]["alice"].id
                    )
                )
                await db.commit()

        asyncio.run(leave())
        assert _rpc(client, raw, "tools/list").status_code == 401

    @pytest.mark.parametrize(
        "body",
        [{"name": "x", "scope": "admin"}, {"name": "x", "ttl_days": 400}, {"name": ""}],
    )
    def test_a_bad_request_is_refused(self, stack, body):
        client, _, jwt, _ = stack
        res = client.post("/users/me/access-tokens", json=body, headers=jwt("alice"))
        assert res.status_code == 422


class TestTransport:
    def test_initialize_and_tools_take_a_project(self, stack):
        client, _, _, pat = stack
        raw = pat("alice")
        init = _rpc(client, raw, "initialize", {"protocolVersion": "2025-06-18"})
        assert init.status_code == 200
        assert init.headers["content-type"].startswith("application/json")
        assert init.json()["result"]["serverInfo"]["name"] == "workpilot-server"
        tools = _rpc(client, raw, "tools/list").json()["result"]["tools"]
        names = {t["name"] for t in tools}
        assert {"list_projects", "list_cards", "create_card", "get_roadmap"} <= names
        for tool in tools:
            if tool["name"] != "list_projects":
                assert "project_id" in tool["inputSchema"]["required"]
            properties = tool["inputSchema"]["properties"]
            assert not any("path" in p or "dir" in p for p in properties)

    def test_a_notification_gets_202(self, stack):
        client, _, _, pat = stack
        raw = pat("alice")
        res = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers={"Authorization": f"Bearer {raw}"},
        )
        assert res.status_code == 202 and res.content == b""

    def test_a_batch_or_garbage_is_refused(self, stack):
        client, _, _, pat = stack
        headers = {"Authorization": f"Bearer {pat('alice')}"}
        batch = client.post(
            "/mcp",
            json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}],
            headers=headers,
        )
        assert batch.status_code == 400
        garbage = client.post("/mcp", content=b"{nope", headers=headers)
        assert garbage.status_code == 400
        assert garbage.json()["error"]["code"] == -32700

    def test_another_origin_is_refused(self, stack):
        client, _, _, pat = stack
        raw = pat("alice")
        assert (
            _rpc(client, raw, "ping", Origin="https://evil.example").status_code == 403
        )
        assert _rpc(client, raw, "ping", Origin="http://testserver").status_code == 200

    def test_mounted_with_the_board(self):
        source = (_BACKEND / "shared_features" / "__init__.py").read_text(
            encoding="utf-8"
        )
        assert 'mount(board_mcp_http, "board")' in source
        from server.authz.mounting import permission_for

        assert permission_for("POST", "/mcp", "task") == "task.read"

    def test_without_server_mode_there_is_nothing(self, monkeypatch):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from shared_board.mcp_http import router as mcp_http_router

        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")
        server_config.reset_settings_cache()
        app = FastAPI()
        app.include_router(mcp_http_router)
        with TestClient(app) as client:
            res = client.post(
                "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}
            )
            assert res.status_code == 404

    def test_no_stream_and_no_session(self, stack):
        client, _, _, pat = stack
        headers = {"Authorization": f"Bearer {pat('alice')}"}
        assert client.get("/mcp", headers=headers).status_code == 405
        delete_res = client.delete("/mcp", headers=headers)
        assert delete_res.status_code == 405
        assert client.get("/mcp").status_code == 401


class TestTools:
    def test_lists_only_the_organizations_projects(self, stack):
        client, world, _, pat = stack
        projects, error = _tool(client, pat("alice"), "list_projects")
        assert not error
        assert projects == [{"id": world["pa"], "name": "PA", "role": "member"}]
        bobs, _ = _tool(client, pat("bob", org="org_b"), "list_projects")
        assert [p["id"] for p in bobs] == [world["pb"]]

    def test_a_member_creates_and_reads_a_card(self, stack, _server_mode):
        client, world, _, pat = stack
        raw = pat("alice")
        card, error = _tool(
            client, raw, "create_card", project_id=world["pa"], title="Add login"
        )
        assert not error and card["column"] == "backlog"
        meta = json.loads(
            (
                world["clone_a"]
                / ".workpilot"
                / "specs"
                / card["id"]
                / "task_metadata.json"
            ).read_text(encoding="utf-8")
        )
        assert meta == {"sourceType": "mcp", "createdBy": world["users"]["alice"].id}
        assert _server_mode == [(world["pa"], "spec_created")]
        listed, _ = _tool(client, raw, "list_cards", project_id=world["pa"])
        assert [c["id"] for c in listed] == [card["id"]]
        spec, _ = _tool(
            client, raw, "get_spec", project_id=world["pa"], card_id=card["id"]
        )
        assert spec["spec"] is None

        edited, error = _tool(
            client,
            raw,
            "update_card",
            project_id=world["pa"],
            card_id=card["id"],
            title="Sign in",
        )
        assert not error and edited["title"] == "Sign in"
        assert _server_mode[-1] == (world["pa"], "spec_updated")

    def test_a_read_token_never_writes(self, stack):
        client, world, _, pat = stack
        value, error = _tool(
            client,
            pat("alice", "read"),
            "create_card",
            project_id=world["pa"],
            title="x",
        )
        assert error and "read-only" in value
        assert not (world["clone_a"] / ".workpilot" / "specs").exists()

    def test_a_viewer_reads_but_does_not_write(self, stack):
        client, world, _, pat = stack
        raw = pat("vic")
        _, error = _tool(client, raw, "list_cards", project_id=world["pa"])
        assert not error
        value, error = _tool(
            client, raw, "create_card", project_id=world["pa"], title="x"
        )
        assert error and "member" in value

    def test_another_organizations_project_is_not_found(self, stack):
        client, world, _, pat = stack
        value, error = _tool(client, pat("alice"), "list_cards", project_id=world["pb"])
        assert error and value == "Error: no such project"
        value, error = _tool(client, pat("alice"), "get_roadmap", project_id="nope")
        assert error and value == "Error: no such project"

    def test_a_project_is_required(self, stack):
        client, _, _, pat = stack
        value, error = _tool(client, pat("alice"), "list_cards")
        assert error and "project_id" in value

    def test_waiting_is_cut_to_five_minutes(self, stack, monkeypatch):
        from board_mcp import server as board

        client, world, _, pat = stack
        raw = pat("alice")
        card, _ = _tool(
            client, raw, "create_card", project_id=world["pa"], title="Wait"
        )
        seen = {}

        async def fake_wait(root, card_id, columns, timeout_s):
            seen["timeout"] = timeout_s
            return {"reached": False}

        monkeypatch.setattr(board, "wait_for_card", fake_wait)
        _tool(
            client,
            raw,
            "wait_for_card",
            project_id=world["pa"],
            card_id=card["id"],
            timeout_seconds=4 * 3600,
        )
        assert seen["timeout"] == 300

    def test_the_server_offers_no_task(self, stack):
        client, _, _, pat = stack
        init = _rpc(
            client, pat("alice"), "initialize", {"protocolVersion": "2025-06-18"}
        )
        assert "extensions" not in init.json()["result"]["capabilities"]
