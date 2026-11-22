"""Server mode: a project team's security reviews of catalogue MCP servers (#369 lot 5).

A member leaves one review per catalogue server, which a second write
replaces; the project's members read them, the newest first. Only its author
or the project owner deletes one; another project's review, a verdict outside
the list, an id that is not a catalogue id, an unknown field, all are
refused. The comment is kept as plain text. The permission is
``marketplace.write``, granted to contributors and reviewers; the route
matrix (``tests/server_routes/test_route_matrix.py``) checks it on the app.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

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
        "sqlite+aiosqlite:///" + str(tmp_path / "reviews.sqlite3").replace("\\", "/"),
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


async def _put(scope, principal=None, **fields):
    from shared_features.mcp_reviews import ReviewIn, put_review

    body = {"server_id": "github", "verdict": "caution", **fields}
    async with _db() as db:
        return (
            await put_review(ReviewIn(**body), scope, principal or _principal(), db)
        )["review"]


async def _list(scope, principal=None, server_id=None):
    from shared_features.mcp_reviews import list_reviews

    async with _db() as db:
        answer = await list_reviews(server_id, scope, principal or _principal(), db)
        return answer["reviews"]


async def _delete(scope, review_id, principal=None):
    from shared_features.mcp_reviews import delete_review

    async with _db() as db:
        return await delete_review(review_id, scope, principal or _principal(), db)


async def test_a_member_reviews_a_server_and_the_team_reads_it(tmp_path):
    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    review = await _put(scope, comment="Works, but  calls\x07 an undocumented host.")

    assert review["server_id"] == "github"
    assert review["verdict"] == "caution"
    assert review["comment"] == "Works, but calls an undocumented host."
    assert review["author"] == "Ada"
    assert review["mine"] is True and review["can_delete"] is True

    bob = _principal("u-2", "Bob")
    (seen,) = await _list(_scope(org_id, project, "viewer"), bob)
    assert seen["id"] == review["id"]
    assert seen["mine"] is False and seen["can_delete"] is False


async def test_a_second_review_replaces_the_first_and_each_person_has_one(tmp_path):
    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    first = await _put(scope, verdict="safe")
    again = await _put(scope, verdict="unsafe", comment="line one\n\n  line two  ")
    assert again["id"] == first["id"]
    assert again["comment"] == "line one\n\nline two"
    await _put(scope, _principal("u-2", "Bob"), verdict="safe")
    await _put(scope, server_id="sentry", verdict="safe")

    reviews = await _list(scope)
    assert len(reviews) == 3
    assert [r["verdict"] for r in await _list(scope, server_id="github")] == [
        "safe",
        "unsafe",
    ]


async def test_reviews_stay_in_their_project(tmp_path):
    org_id, (project, other) = await _projects(tmp_path)
    review = await _put(_scope(org_id, project))
    assert await _list(_scope(org_id, other)) == []
    with pytest.raises(HTTPException) as refused:
        await _delete(_scope(org_id, other, "owner"), review["id"])
    assert refused.value.status_code == 404
    with pytest.raises(HTTPException) as missing:
        await _delete(_scope(org_id, project), "0" * 8 + "-0000-0000-0000-" + "0" * 12)
    assert missing.value.status_code == 404


async def test_only_its_author_or_the_owner_deletes_a_review(tmp_path):
    org_id, (project, _other) = await _projects(tmp_path)
    review = await _put(_scope(org_id, project))
    bob = _principal("u-2", "Bob")
    with pytest.raises(HTTPException) as refused:
        await _delete(_scope(org_id, project), review["id"], bob)
    assert refused.value.status_code == 403

    owner_view = await _list(_scope(org_id, project, "owner"), bob)
    assert owner_view[0]["can_delete"] is True
    assert await _delete(_scope(org_id, project, "owner"), review["id"], bob) == {
        "deleted": True
    }
    assert await _list(_scope(org_id, project)) == []

    again = await _put(_scope(org_id, project))
    admin = _principal("u-2", "Bob", permissions=("project.member.write",))
    await _delete(_scope(org_id, project, None), again["id"], admin)
    mine = await _put(_scope(org_id, project))
    assert await _delete(_scope(org_id, project), mine["id"]) == {"deleted": True}


@pytest.mark.parametrize(
    "body",
    [
        {"server_id": "github", "verdict": "great"},
        {"server_id": "../etc", "verdict": "safe"},
        {"server_id": "", "verdict": "safe"},
        {"server_id": "a" * 101, "verdict": "safe"},
        {"server_id": "github", "verdict": "safe", "comment": "x" * 1001},
        {"server_id": "github", "verdict": "safe", "author": "Someone else"},
        {"server_id": "github", "verdict": "safe", "project_dir": "/etc"},
    ],
)
def test_a_review_outside_the_schema_is_refused(body):
    from shared_features.mcp_reviews import ReviewIn

    with pytest.raises(ValidationError):
        ReviewIn(**body)


async def test_a_project_holds_a_bounded_number_of_reviews(tmp_path, monkeypatch):
    import shared_features.mcp_reviews as reviews

    org_id, (project, _other) = await _projects(tmp_path)
    scope = _scope(org_id, project)
    monkeypatch.setattr(reviews, "MAX_REVIEWS", 1)
    await _put(scope)
    # Replacing one's own review is not a new one.
    await _put(scope, verdict="safe")
    with pytest.raises(HTTPException) as refused:
        await _put(scope, server_id="sentry")
    assert refused.value.status_code == 422
    assert refused.value.detail == "too_many_reviews"


async def test_a_name_from_the_email_when_there_is_none(tmp_path):
    org_id, (project, _other) = await _projects(tmp_path)
    review = await _put(_scope(org_id, project), _principal(name=""))
    assert review["author"] == "u-1@x"


def test_timestamps_without_a_zone_read_as_utc():
    from datetime import datetime

    from shared_features.mcp_reviews import _iso

    assert _iso(None) is None
    assert _iso(datetime(2026, 11, 22, 10, 0)) == "2026-11-22T10:00:00+00:00"


def test_the_permission_is_granted_to_contributors_and_reviewers():
    from server.authz.catalog import (
        PERMISSIONS,
        PRIVILEGED_PERMISSION_KEYS,
        SERVER_FEATURES,
        domain_for_feature,
    )
    from server.authz.roles import system_role

    assert "marketplace.write" in PERMISSIONS
    assert "marketplace.write" not in PRIVILEGED_PERMISSION_KEYS
    assert domain_for_feature("mcp_reviews") == "marketplace"
    assert "mcp_reviews" in SERVER_FEATURES
    for slug in ("contributor", "reviewer", "maintainer", "admin"):
        assert "marketplace.write" in system_role(slug).permissions
    for slug in ("viewer", "analyst", "operator"):
        assert "marketplace.write" not in system_role(slug).permissions
        assert "marketplace.read" in system_role(slug).permissions


def test_the_reviews_table_comes_and_goes_with_its_revision(tmp_path, monkeypatch):
    sa = pytest.importorskip("sqlalchemy")
    pytest.importorskip("alembic")
    from alembic import command
    from alembic.config import Config

    db = tmp_path / "migrations.sqlite3"
    monkeypatch.setenv("WORKPILOT_DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    config = Config(str(_BACKEND / "server" / "db" / "alembic.ini"))

    def tables() -> set[str]:
        engine = sa.create_engine(f"sqlite:///{db}")
        try:
            return set(sa.inspect(engine).get_table_names())
        finally:
            engine.dispose()

    command.upgrade(config, "head")
    assert "mcp_server_reviews" in tables()
    command.downgrade(config, "0019_login_sessions")
    assert "mcp_server_reviews" not in tables()
    # A table already there (``create_all`` of a newer build) is kept.
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(
                sa.text("CREATE TABLE mcp_server_reviews (id VARCHAR(36))")
            )
    finally:
        engine.dispose()
    command.upgrade(config, "head")
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("DROP TABLE mcp_server_reviews"))
    finally:
        engine.dispose()
    # A table already gone does not stop the downgrade.
    command.downgrade(config, "0019_login_sessions")
    assert "mcp_server_reviews" not in tables()
    command.upgrade(config, "head")
    engine = sa.create_engine(f"sqlite:///{db}")
    try:
        indexes = {
            i["name"] for i in sa.inspect(engine).get_indexes("mcp_server_reviews")
        }
    finally:
        engine.dispose()
    assert "ix_mcp_server_reviews_project" in indexes
