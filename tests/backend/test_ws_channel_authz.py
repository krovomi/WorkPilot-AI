"""Server mode: a streaming channel opens only for a token entitled to it.

A valid token used to open any channel, and a connection could move to any
other one with ``init_session`` or publish into one by naming it in an event:
a member of one organization could follow, and write into, another
organization's board. These tests hold the channel to its project's members,
a run's token to its own run, and the WS server to that answer on connect, on
switch and on publish.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "ws.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _world():
    """Two organizations, one project each, and their people.

    alice: member of org A, member of project A.
    vic: member of org A, viewer of project A.
    olga: org A member with no role on project A.
    bob: member of org B, owner of project B.
    """
    from server.db import engine as db_engine
    from server.db.models import (
        AgentRun,
        Organization,
        OrgMember,
        Project,
        ProjectMember,
        Role,
        SpecIndex,
        User,
    )
    from sqlalchemy import select

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with db_engine.get_session_factory()() as db:
        contributor = await db.scalar(
            select(Role.id).where(Role.slug == "contributor", Role.org_id.is_(None))
        )
        org_a = Organization(name="A", slug="org-a")
        org_b = Organization(name="B", slug="org-b")
        db.add_all([org_a, org_b])
        await db.flush()
        people = {
            name: User(email=f"{name}@example.com", display_name=name)
            for name in ("alice", "vic", "olga", "bob")
        }
        db.add_all(people.values())
        await db.flush()
        for name, org in (
            ("alice", org_a),
            ("vic", org_a),
            ("olga", org_a),
            ("bob", org_b),
        ):
            db.add(
                OrgMember(org_id=org.id, user_id=people[name].id, role_id=contributor)
            )
        proj_a = Project(
            org_id=org_a.id, name="PA", repo_url="https://x/a.git", server_path="/tmp/a"
        )
        proj_b = Project(
            org_id=org_b.id, name="PB", repo_url="https://x/b.git", server_path="/tmp/b"
        )
        db.add_all([proj_a, proj_b])
        await db.flush()
        db.add_all(
            [
                ProjectMember(
                    project_id=proj_a.id, user_id=people["alice"].id, role="member"
                ),
                ProjectMember(
                    project_id=proj_a.id, user_id=people["vic"].id, role="viewer"
                ),
                ProjectMember(
                    project_id=proj_b.id, user_id=people["bob"].id, role="owner"
                ),
            ]
        )
        spec_a = SpecIndex(project_id=proj_a.id, spec_name="s-a")
        spec_b = SpecIndex(project_id=proj_b.id, spec_name="s-b")
        db.add_all([spec_a, spec_b])
        await db.flush()
        run_a = AgentRun(spec_id=spec_a.id, phase="build")
        run_b = AgentRun(spec_id=spec_b.id, phase="build")
        db.add_all([run_a, run_b])
        await db.commit()
        return {
            "org_a": org_a.id,
            "org_b": org_b.id,
            "proj_a": proj_a.id,
            "proj_b": proj_b.id,
            "run_a": run_a.id,
            "run_b": run_b.id,
            **{name: user.id for name, user in people.items()},
        }


def _user(w, name, org):
    return {"sub": w[name], "org": w[org], "role": "member", "name": name}


async def _grant(claims, channel, org_hint=None):
    from server.authz.ws_channels import authorize_channel
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        return await authorize_channel(db, claims, channel, org_hint=org_hint)


@pytest.mark.asyncio
async def test_a_project_member_reads_and_interacts_on_their_project():
    w = await _world()
    grant = await _grant(_user(w, "alice", "org_a"), f"project:{w['proj_a']}")
    assert grant is not None
    assert grant.can_interact and not grant.can_publish


@pytest.mark.asyncio
async def test_a_viewer_reads_but_does_not_interact():
    w = await _world()
    grant = await _grant(_user(w, "vic", "org_a"), f"project:{w['proj_a']}")
    assert grant is not None
    assert not grant.can_interact and not grant.can_publish


@pytest.mark.asyncio
async def test_another_tenants_project_and_run_are_refused():
    w = await _world()
    alice = _user(w, "alice", "org_a")
    assert await _grant(alice, f"project:{w['proj_b']}") is None
    assert await _grant(alice, f"run:{w['run_b']}") is None
    # Naming the other organization does not help: alice is not in it.
    assert await _grant(alice, f"project:{w['proj_b']}", org_hint=w["org_b"]) is None


@pytest.mark.asyncio
async def test_an_org_member_without_a_project_role_is_refused():
    w = await _world()
    assert await _grant(_user(w, "olga", "org_a"), f"project:{w['proj_a']}") is None


@pytest.mark.asyncio
async def test_a_run_channel_follows_its_projects_members():
    w = await _world()
    assert await _grant(_user(w, "alice", "org_a"), f"run:{w['run_a']}") is not None
    assert await _grant(_user(w, "bob", "org_b"), f"run:{w['run_b']}") is not None
    assert await _grant(_user(w, "bob", "org_b"), f"run:{w['run_a']}") is None


@pytest.mark.asyncio
async def test_a_run_token_opens_its_own_run_only():
    w = await _world()
    token = {"sub": "service:agent", "role": "service", "run": w["run_a"]}
    grant = await _grant(token, f"run:{w['run_a']}")
    assert grant is not None and grant.can_publish
    assert await _grant(token, f"run:{w['run_b']}") is None
    assert await _grant(token, f"project:{w['proj_a']}") is None
    assert (
        await _grant({"sub": "service:agent", "role": "service"}, f"run:{w['run_a']}")
        is None
    )


@pytest.mark.asyncio
async def test_unknown_channels_subjects_and_deactivated_users_are_refused():
    from server.db.engine import get_session_factory
    from server.db.models import User

    w = await _world()
    alice = _user(w, "alice", "org_a")
    for channel in (
        "default",
        "session-1",
        "project:",
        f"project:{w['proj_a']}:x",
        "x:y",
    ):
        assert await _grant(alice, channel) is None, channel
    assert (
        await _grant(
            {"sub": "service:other", "role": "service"}, f"project:{w['proj_a']}"
        )
        is None
    )
    assert (
        await _grant({"sub": "nobody", "role": "member"}, f"project:{w['proj_a']}")
        is None
    )

    async with get_session_factory()() as db:
        user = await db.get(User, w["alice"])
        user.is_active = False
        await db.commit()
    assert await _grant(alice, f"project:{w['proj_a']}") is None


@pytest.mark.asyncio
async def test_the_api_service_token_publishes_board_events():
    w = await _world()
    grant = await _grant(
        {"sub": "service:api", "role": "service"}, f"project:{w['proj_a']}"
    )
    assert grant is not None and grant.can_publish


# --- the WS server applies the answer --------------------------------------


class _FakeSocket:
    def __init__(self, path: str):
        self.path = path
        self.request = None
        self.remote_address = ("127.0.0.1", 0)
        self.sent: list[dict] = []
        self.closed: tuple[int, str] | None = None

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


def _token(claims: dict) -> str:
    import time

    import jwt as pyjwt

    now = int(time.time())
    return pyjwt.encode(
        {"iss": "workpilot", "iat": now, "exp": now + 600, **claims},
        _VALID_SECRET,
        algorithm="HS256",
    )


def _server():
    from streaming.websocket_server import StreamingWebSocketServer

    return StreamingWebSocketServer()


async def _connect(server, path):
    ws = _FakeSocket(path)
    ctx = {"session_id": None}
    server._extract_websocket_path = lambda _ws: path
    await server._setup_client_connection(ws, ctx)
    return ws, ctx


@pytest.mark.asyncio
async def test_ws_server_refuses_another_tenants_channel_on_connect():
    from streaming.websocket_server import WS_CLOSE_FORBIDDEN

    w = await _world()
    server = _server()
    token = _token(_user(w, "alice", "org_a"))
    ws, ctx = await _connect(server, f"/stream/project:{w['proj_b']}?token={token}")
    assert ws.closed is not None and ws.closed[0] == WS_CLOSE_FORBIDDEN
    assert ctx["session_id"] is None
    assert f"project:{w['proj_b']}" not in server._clients


@pytest.mark.asyncio
async def test_ws_server_refuses_a_switch_to_another_tenants_channel():
    w = await _world()
    server = _server()
    token = _token(_user(w, "alice", "org_a"))
    ws, ctx = await _connect(server, f"/stream/project:{w['proj_a']}?token={token}")
    assert ws.closed is None and ctx["session_id"] == f"project:{w['proj_a']}"

    await server._handle_message(
        ctx,
        ws,
        json.dumps({"type": "init_session", "session_id": f"project:{w['proj_b']}"}),
    )
    assert ctx["session_id"] == f"project:{w['proj_a']}"
    assert ws not in server._clients.get(f"project:{w['proj_b']}", set())


@pytest.mark.asyncio
async def test_ws_server_keeps_users_from_publishing_and_events_on_their_channel():
    w = await _world()
    server = _server()
    published: list[str] = []

    async def _spy(session_id, event, exclude=None):
        published.append(session_id)

    server._broadcast_to_subscribers = _spy
    event = {
        "type": "agent_event",
        "event": {
            "event_type": "agent_thinking",
            "session_id": f"project:{w['proj_b']}",
            "data": {},
        },
    }

    user_token = _token(_user(w, "alice", "org_a"))
    ws, ctx = await _connect(
        server, f"/stream/project:{w['proj_a']}?token={user_token}"
    )
    await server._handle_message(ctx, ws, json.dumps(event))
    assert published == []  # a user does not publish agent events

    run_token = _token({"sub": "service:agent", "role": "service", "run": w["run_a"]})
    ws, ctx = await _connect(server, f"/stream/run:{w['run_a']}?token={run_token}")
    await server._handle_message(ctx, ws, json.dumps(event))
    # Published, but on the run's own channel, not the one the event named.
    assert published == [f"run:{w['run_a']}"]


def test_ws_server_fails_closed_when_server_settings_cannot_load(monkeypatch):
    from streaming import websocket_server

    monkeypatch.delenv("WORKPILOT_JWT_SECRET", raising=False)
    server_config.reset_settings_cache()
    assert websocket_server._server_mode_enabled() is True
