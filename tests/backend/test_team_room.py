"""Server mode: who is on a project, and its team chat, over the project's stream.

The members who follow ``project:<id>`` see each other (by name, never by
email) and write in the project's chat; a viewer reads it without writing;
another project, or another tenant, hears nothing of it. Messages are stored,
so someone who arrives later reads the latest ones.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_SECRET = "y" * 48


@pytest.fixture(autouse=True)
def _server_mode(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "room.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _world() -> dict[str, str]:
    """alice (member) and vic (viewer) on project A; bob owns project B elsewhere."""
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
        proj_a = Project(org_id=org_a.id, name="PA", repo_url="x", server_path="/a")
        proj_b = Project(org_id=org_b.id, name="PB", repo_url="x", server_path="/b")
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
        await db.commit()
        return {
            "org_a": org_a.id,
            "org_b": org_b.id,
            "proj_a": proj_a.id,
            "proj_b": proj_b.id,
            **{name: user.id for name, user in people.items()},
        }


class _Socket:
    def __init__(self) -> None:
        self.request = None
        self.remote_address = ("127.0.0.1", 0)
        self.sent: list[dict] = []
        self.closed: tuple[int, str] | None = None

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    def events(self, kind: str) -> list[dict]:
        return [e["data"] for e in self.sent if e.get("event_type") == kind]


def _token(claims: dict) -> str:
    import jwt as pyjwt

    now = int(time.time())
    return pyjwt.encode(
        {"iss": "workpilot", "iat": now, "exp": now + 600, **claims},
        _SECRET,
        algorithm="HS256",
    )


def _person(w, name, org="org_a"):
    return {
        "sub": w[name],
        "org": w[org],
        "role": "member",
        "name": name.title(),
        "email": f"{name}@example.com",
    }


async def _connect(server, channel: str, claims: dict):
    ws = _Socket()
    ctx: dict = {"session_id": None}
    path = f"/stream/{channel}?token={_token(claims)}"
    server._extract_websocket_path = lambda _ws: path
    await server._setup_client_connection(ws, ctx)
    return ws, ctx


def _server():
    from streaming.websocket_server import StreamingWebSocketServer

    return StreamingWebSocketServer()


async def _say(server, ws, ctx, message, **extra) -> None:
    await server._handle_message(
        ctx, ws, json.dumps({"type": "chat_message", "message": message, **extra})
    )


@pytest.mark.asyncio
async def test_members_see_who_is_on_the_project_and_who_leaves():
    w = await _world()
    server = _server()
    channel = f"project:{w['proj_a']}"
    alice, alice_ctx = await _connect(server, channel, _person(w, "alice"))
    assert alice.events("presence")[-1]["users"] == [
        {"id": w["alice"], "name": "Alice"}
    ]
    assert alice.events("chat_history") == [{"messages": []}]

    vic, vic_ctx = await _connect(server, channel, _person(w, "vic"))
    both = [{"id": w["alice"], "name": "Alice"}, {"id": w["vic"], "name": "Vic"}]
    assert alice.events("presence")[-1]["users"] == both
    assert vic.events("presence")[-1]["users"] == both
    # The API's service connection publishes; it is nobody in the room.
    await _connect(server, channel, {"sub": "service:api", "role": "service"})
    assert len(alice.events("presence")) == 2
    assert "example.com" not in json.dumps(alice.sent)

    server._cleanup_client(vic_ctx["session_id"], vic)
    await asyncio.sleep(0)
    assert alice.events("presence")[-1]["users"] == [
        {"id": w["alice"], "name": "Alice"}
    ]
    # A second cleanup of the same connection announces nothing more.
    server._cleanup_client(vic_ctx["session_id"], vic)
    await asyncio.sleep(0)
    assert len(alice.events("presence")) == 3
    assert alice_ctx["session_id"] == channel


@pytest.mark.asyncio
async def test_a_message_reaches_the_room_and_is_kept():
    w = await _world()
    server = _server()
    channel = f"project:{w['proj_a']}"
    alice, alice_ctx = await _connect(server, channel, _person(w, "alice"))
    vic, _ = await _connect(server, channel, _person(w, "vic"))
    bob, _ = await _connect(
        server, f"project:{w['proj_b']}", _person(w, "bob", "org_b")
    )

    await _say(server, alice, alice_ctx, "  Hello\x00 team  ")
    [sent] = vic.events("chat_message")
    assert sent["message"] == "Hello team"
    assert (sent["author"], sent["author_id"]) == ("Alice", w["alice"])
    assert alice.events("chat_message") == [sent]  # the author hears it back
    assert bob.events("chat_message") == []

    await _say(server, alice, alice_ctx, "Re", reply_to=sent["id"])
    assert vic.events("chat_message")[-1]["reply_to"] == sent["id"]

    later, _ = await _connect(server, channel, _person(w, "alice"))
    history = later.events("chat_history")[-1]["messages"]
    assert [m["message"] for m in history] == ["Hello team", "Re"]


@pytest.mark.asyncio
async def test_a_viewer_reads_the_chat_without_writing():
    w = await _world()
    server = _server()
    channel = f"project:{w['proj_a']}"
    alice, _ = await _connect(server, channel, _person(w, "alice"))
    vic, vic_ctx = await _connect(server, channel, _person(w, "vic"))
    await _say(server, vic, vic_ctx, "let me in")
    assert vic.events("chat_rejected") == [{"reason": "forbidden"}]
    assert alice.events("chat_message") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["", "   ", 42, None, "x" * 2001])
async def test_a_message_that_is_not_one_is_refused(message):
    w = await _world()
    server = _server()
    alice, ctx = await _connect(server, f"project:{w['proj_a']}", _person(w, "alice"))
    await _say(server, alice, ctx, message)
    assert alice.events("chat_message") == []
    assert alice.events("chat_rejected") == [{"reason": "invalid"}]


@pytest.mark.asyncio
async def test_a_burst_of_messages_is_slowed_down():
    w = await _world()
    server = _server()
    alice, ctx = await _connect(server, f"project:{w['proj_a']}", _person(w, "alice"))
    for n in range(7):
        await _say(server, alice, ctx, f"m{n}")
    assert len(alice.events("chat_message")) == 5
    assert alice.events("chat_rejected") == [{"reason": "too_fast"}] * 2


@pytest.mark.asyncio
async def test_a_reply_to_another_projects_message_is_dropped():
    from server.services.team_chat import save_message

    w = await _world()
    elsewhere = await save_message(w["proj_b"], w["bob"], "Bob", "secret")
    server = _server()
    alice, ctx = await _connect(server, f"project:{w['proj_a']}", _person(w, "alice"))
    await _say(server, alice, ctx, "hi", reply_to=elsewhere["id"])
    assert alice.events("chat_message")[-1]["reply_to"] == ""


@pytest.mark.asyncio
async def test_another_tenants_member_never_joins_the_room():
    w = await _world()
    server = _server()
    alice, _ = await _connect(server, f"project:{w['proj_a']}", _person(w, "alice"))
    bob, _ = await _connect(
        server, f"project:{w['proj_a']}", _person(w, "bob", "org_b")
    )
    assert bob.closed is not None
    assert bob.events("presence") == [] and bob.events("chat_history") == []
    assert len(alice.events("presence")) == 1


@pytest.mark.asyncio
async def test_the_history_holds_the_latest_messages_oldest_first():
    from server.services.team_chat import recent_messages, save_message

    w = await _world()
    for n in range(5):
        await save_message(w["proj_a"], w["alice"], "Alice", f"m{n}")
    latest = await recent_messages(w["proj_a"], limit=3)
    assert [m["message"] for m in latest] == ["m2", "m3", "m4"]
    assert all(m["at"].endswith("+00:00") for m in latest)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("a\tb\nc", "a\tb\nc"), ("\x1b[31mred", "[31mred"), ("x" * 2000, "x" * 2000)],
)
def test_a_message_keeps_its_lines_and_loses_control_characters(raw, expected):
    from server.services.team_chat import clean_message

    assert clean_message(raw) == expected


@pytest.mark.asyncio
async def test_a_store_failure_is_told_to_the_author(monkeypatch):
    from server.services import team_chat
    from sqlalchemy.exc import OperationalError

    async def _down(*_args, **_kwargs):
        raise OperationalError("insert", {}, Exception("database is locked"))

    w = await _world()
    server = _server()
    alice, ctx = await _connect(server, f"project:{w['proj_a']}", _person(w, "alice"))
    monkeypatch.setattr(team_chat, "save_message", _down)
    await _say(server, alice, ctx, "hello")
    assert alice.events("chat_message") == []
    assert alice.events("chat_rejected") == [{"reason": "unavailable"}]
