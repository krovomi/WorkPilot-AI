"""Server mode: a recorded agent session left with a project's team (#347).

A member leaves a `.wpreplay` with the project and gets a token, once; the
server keeps only the token's hash. A member who holds the link opens the
bundle until it expires or is revoked, and each opening is counted. A viewer
cannot leave one; only its author or the project owner revokes it; another
project's share, a wrong token, a bundle that is not one, all are refused.
"""

from __future__ import annotations

import base64
import hashlib
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "shares.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _projects(tmp_path: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    ids = []
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        for uid, name in (("u-1", "Ada"), ("u-2", "Bob")):
            db.add(User(id=uid, email=f"{uid}@x", display_name=name))
        for name in ("p", "q"):
            clone = tmp_path / "repos" / name
            clone.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(clone)], check=True)
            project = Project(
                org_id=org.id,
                name=name,
                repo_url=f"https://x/{name}.git",
                server_path=str(clone),
            )
            db.add(project)
            await db.flush()
            ids.append((project.id, clone))
        await db.commit()
        return org.id, ids


def _scope(org_id, project, role="member"):
    from server.authz.scope import ProjectScope

    project_id, clone = project
    return ProjectScope(project_id, org_id, clone, role)


def _principal(user="u-1", name="Ada", permissions=()):
    from server.authz.principal import Principal

    return Principal(
        id=user,
        email=f"{user}@x",
        display_name=name,
        permissions=frozenset(permissions),
    )


def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


def _bundle(task="Fix the login bug", steps=2) -> str:
    from replay.bundle import ExportOptions, build_bundle, encode
    from replay.models import ReplaySession, ReplayStep, ReplayStepType

    session = ReplaySession(
        session_id="s-1",
        agent_name="coder",
        task_description=task,
        steps=[
            ReplayStep(id=f"s{i}", step_index=i, step_type=ReplayStepType.TOOL_CALL)
            for i in range(steps)
        ],
        status="completed",
    )
    data = encode(build_bundle(session, ExportOptions()))
    return base64.b64encode(data).decode("ascii")


async def _create(scope, principal=None, content=None, ttl=7):
    from shared_features.replay_shares import CreateShareRequest, create_share

    async with _db() as db:
        return await create_share(
            CreateShareRequest(content_base64=content or _bundle(), ttl_days=ttl),
            scope,
            principal or _principal(),
            db,
        )


async def _open(scope, share_id, token):
    from shared_features.replay_shares import OpenShareRequest, open_share

    async with _db() as db:
        return await open_share(OpenShareRequest(token=token), share_id, scope, db)


async def _list(scope, principal=None):
    from shared_features.replay_shares import list_shares

    async with _db() as db:
        return (await list_shares(scope, principal or _principal(), db))["shares"]


async def _revoke(scope, share_id, principal=None):
    from shared_features.replay_shares import revoke_share

    async with _db() as db:
        return await revoke_share(share_id, scope, principal or _principal(), db)


async def test_a_member_shares_and_a_teammate_opens_it(tmp_path):
    from server.db.models import ReplayShare

    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    created = await _create(scope, ttl=3)
    share, token = created["share"], created["token"]

    assert share["title"] == "coder: Fix the login bug"
    assert share["steps"] == 2
    assert share["created_by"] == "Ada"
    assert share["state"] == "active"
    assert share["can_revoke"] is True
    expires = datetime.fromisoformat(share["expires_at"])
    assert (
        timedelta(days=2, hours=23) < expires - datetime.now(UTC) <= timedelta(days=3)
    )
    # The database holds the token's hash, never the token.
    async with _db() as db:
        row = await db.get(ReplayShare, share["id"])
        assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert token not in row.token_hash

    opened = await _open(_scope(org_id, project, "viewer"), share["id"], token)
    assert base64.b64decode(opened["content_base64"])[:2] == b"\x1f\x8b"
    assert opened["title"] == share["title"]
    await _open(scope, share["id"], token)

    bob = _principal("u-2", "Bob")
    (listed,) = await _list(_scope(org_id, project, "viewer"), bob)
    assert listed["open_count"] == 2
    assert listed["last_opened_at"] is not None
    assert listed["can_revoke"] is False
    assert "token" not in listed and "bundle" not in listed


async def test_a_title_without_a_task_and_a_name_from_the_email(tmp_path):
    from shared_features.replay_shares import _read_bundle

    org_id, (project, _other) = await _projects(tmp_path)
    created = await _create(
        _scope(org_id, project), _principal(name=""), content=_bundle(task="  ")
    )
    assert created["share"]["title"] == "coder"
    assert created["share"]["created_by"] == "u-1@x"
    _data, title, _steps, bookmarks = _read_bundle(_bundle(task="x" * 500))
    assert len(title) == 200
    assert bookmarks == 0


async def test_a_wrong_token_another_project_or_an_unknown_id_is_not_found(tmp_path):
    org_id, (project, other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    created = await _create(scope)
    share_id, token = created["share"]["id"], created["token"]

    for target, sid, tok in (
        (scope, share_id, token + "x"),
        (_scope(org_id, other), share_id, token),
        (scope, "00000000-0000-4000-8000-000000000000", token),
    ):
        with pytest.raises(HTTPException) as refused:
            await _open(target, sid, tok)
        assert (refused.value.status_code, refused.value.detail) == (
            404,
            "share_not_found",
        )
    with pytest.raises(HTTPException) as refused:
        await _revoke(_scope(org_id, other), share_id)
    assert refused.value.status_code == 404
    assert await _list(_scope(org_id, other)) == []


async def test_a_viewer_cannot_share_and_an_admin_without_a_role_can(tmp_path):
    org_id, (project, _other) = await _projects(tmp_path)
    with pytest.raises(HTTPException) as refused:
        await _create(_scope(org_id, project, "viewer"))
    assert refused.value.status_code == 403
    with pytest.raises(HTTPException):
        await _create(_scope(org_id, project, None))
    admin = _principal(permissions={"project.member.write"})
    created = await _create(_scope(org_id, project, None), admin)
    assert created["share"]["can_revoke"] is True


@pytest.mark.parametrize(
    ("content", "detail"),
    [
        ("not base64!", "unreadable"),
        (base64.b64encode(b'{"format": "other"}').decode(), "not_a_bundle"),
    ],
)
async def test_what_is_not_a_bundle_is_refused(tmp_path, content, detail):
    org_id, (project, _other) = await _projects(tmp_path)
    with pytest.raises(HTTPException) as refused:
        await _create(_scope(org_id, project), content=content)
    assert (refused.value.status_code, refused.value.detail) == (422, detail)
    assert await _list(_scope(org_id, project)) == []


async def test_a_bundle_over_the_bound_is_refused(tmp_path, monkeypatch):
    from shared_features import replay_shares

    org_id, (project, _other) = await _projects(tmp_path)
    monkeypatch.setattr(replay_shares, "MAX_SHARED_BYTES", 10)
    with pytest.raises(HTTPException) as refused:
        await _create(_scope(org_id, project))
    assert refused.value.detail == "too_large"


async def test_only_the_author_or_the_owner_revokes_and_a_revoked_link_is_gone(
    tmp_path,
):
    from server.db.models import ReplayShare

    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    created = await _create(scope)
    share_id, token = created["share"]["id"], created["token"]

    bob = _principal("u-2", "Bob")
    with pytest.raises(HTTPException) as refused:
        await _revoke(scope, share_id, bob)
    assert refused.value.status_code == 403
    assert await _revoke(_scope(org_id, project, "owner"), share_id, bob) == {
        "revoked": True
    }
    async with _db() as db:
        row = await db.get(ReplayShare, share_id)
        first = row.revoked_at
        assert row.bundle == b""
    # Revoking again keeps the first date.
    await _revoke(scope, share_id)
    async with _db() as db:
        assert (await db.get(ReplayShare, share_id)).revoked_at == first

    with pytest.raises(HTTPException) as refused:
        await _open(scope, share_id, token)
    assert (refused.value.status_code, refused.value.detail) == (410, "share_revoked")
    (listed,) = await _list(scope)
    assert listed["state"] == "revoked"


async def test_an_expired_link_answers_410_and_ended_shares_are_forgotten(tmp_path):
    from server.db.models import ReplayShare

    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    expired = await _create(scope)
    old_revoked = await _create(scope)
    recent_revoked = await _create(scope)
    async with _db() as db:
        row = await db.get(ReplayShare, expired["share"]["id"])
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await db.commit()
    with pytest.raises(HTTPException) as refused:
        await _open(scope, expired["share"]["id"], expired["token"])
    assert (refused.value.status_code, refused.value.detail) == (410, "share_expired")
    states = {s["id"]: s["state"] for s in await _list(scope)}
    assert states[expired["share"]["id"]] == "expired"

    await _revoke(scope, old_revoked["share"]["id"])
    await _revoke(scope, recent_revoked["share"]["id"])
    long_ago = datetime.now(UTC) - timedelta(days=40)
    async with _db() as db:
        (await db.get(ReplayShare, expired["share"]["id"])).expires_at = long_ago
        (await db.get(ReplayShare, old_revoked["share"]["id"])).revoked_at = long_ago
        await db.commit()
    await _create(scope)
    kept = {s["id"] for s in await _list(scope)}
    assert expired["share"]["id"] not in kept
    assert old_revoked["share"]["id"] not in kept
    assert recent_revoked["share"]["id"] in kept


async def test_a_project_keeps_a_bounded_number_of_open_shares(tmp_path, monkeypatch):
    from shared_features import replay_shares

    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    monkeypatch.setattr(replay_shares, "MAX_ACTIVE_SHARES", 1)
    first = await _create(scope)
    with pytest.raises(HTTPException) as refused:
        await _create(scope)
    assert refused.value.detail == "too_many_shares"
    await _revoke(scope, first["share"]["id"])
    await _create(scope)


def test_a_naive_database_time_reads_as_utc():
    from shared_features.replay_shares import _aware, _iso

    naive = datetime(2026, 11, 21, 10, 0)
    assert _aware(naive).tzinfo is UTC
    assert _iso(None) is None
