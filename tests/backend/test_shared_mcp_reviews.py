"""Server mode: an organization's security reviews of catalogue MCP servers (#369).

A member leaves one review per catalogue server and organization, which a
second write replaces, from any project of it; every project of the
organization reads them, the newest first, and no other organization does.
Only its author or an organization administrator deletes one; another
organization's review, a verdict outside the list, an id that is not a
catalogue id, an unknown field, all are refused. The comment is kept as
plain text. The permission is ``marketplace.write``, granted to maintainers
and administrators; the route matrix
(``tests/server_routes/test_route_matrix.py``) checks it on the app.
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


class World:
    """Organization A with projects ``p`` and ``q``; B with project ``r``."""

    def __init__(self, org_a: str, org_b: str, projects: list[tuple[str, Path]]):
        self.org = org_a
        self.project, self.other = projects[0], projects[1]
        self.foreign_org = org_b
        self.foreign = projects[2]

    def scope(self, project=None, role="member", org=None):
        from server.authz.scope import ProjectScope

        project_id, clone = project or self.project
        return ProjectScope(project_id, org or self.org, clone, role)

    def foreign_scope(self, role="member"):
        return self.scope(self.foreign, role, self.foreign_org)


async def _world(tmp_path: Path) -> World:
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    projects = []
    async with db_engine.get_session_factory()() as db:
        orgs = {}
        for slug in ("org-a", "org-b"):
            org = Organization(name=slug, slug=slug)
            db.add(org)
            await db.flush()
            orgs[slug] = org.id
        for uid, name in (("u-1", "Ada"), ("u-2", "Bob"), ("u-3", "Eve")):
            db.add(User(id=uid, email=f"{uid}@x", display_name=name))
        for name, slug in (("p", "org-a"), ("q", "org-a"), ("r", "org-b")):
            clone = tmp_path / "repos" / name
            clone.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(clone)], check=True)
            project = Project(
                org_id=orgs[slug],
                name=name,
                repo_url=f"https://x/{name}.git",
                server_path=str(clone),
            )
            db.add(project)
            await db.flush()
            projects.append((project.id, clone))
        await db.commit()
    return World(orgs["org-a"], orgs["org-b"], projects)


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


async def _answer(scope, principal=None, server_id=None):
    from shared_features.mcp_reviews import list_reviews

    async with _db() as db:
        return await list_reviews(server_id, scope, principal or _principal(), db)


async def _list(scope, principal=None, server_id=None):
    return (await _answer(scope, principal, server_id))["reviews"]


async def _delete(scope, review_id, principal=None):
    from shared_features.mcp_reviews import delete_review

    async with _db() as db:
        return await delete_review(review_id, scope, principal or _principal(), db)


async def test_a_member_reviews_a_server_and_the_team_reads_it(tmp_path):
    world = await _world(tmp_path)
    review = await _put(
        world.scope(), comment="Works, but  calls\x07 an undocumented host."
    )

    assert review["server_id"] == "github"
    assert review["verdict"] == "caution"
    assert review["comment"] == "Works, but calls an undocumented host."
    assert review["author"] == "Ada"
    assert review["mine"] is True and review["can_delete"] is True

    bob = _principal("u-2", "Bob")
    (seen,) = await _list(world.scope(role="viewer"), bob)
    assert seen["id"] == review["id"]
    assert seen["mine"] is False and seen["can_delete"] is False


async def test_a_second_review_replaces_the_first_and_each_person_has_one(tmp_path):
    world = await _world(tmp_path)
    scope = world.scope()
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


async def test_reviews_are_shared_by_the_projects_of_one_organization(tmp_path):
    from server.db.models import McpServerReview

    world = await _world(tmp_path)
    review = await _put(world.scope(), comment="seen from p")
    bob = _principal("u-2", "Bob")
    (seen,) = await _list(world.scope(world.other, "viewer"), bob)
    assert seen["id"] == review["id"] and seen["comment"] == "seen from p"
    # The project it was written from is never shown.
    assert not {"project_id", "project"} & set(seen)

    # One review per person and organization: writing it from another of
    # its projects replaces it, which then counts as written from there.
    again = await _put(world.scope(world.other), verdict="unsafe")
    assert again["id"] == review["id"]
    assert [r["verdict"] for r in await _list(world.scope())] == ["unsafe"]
    async with _db() as db:
        row = await db.get(McpServerReview, review["id"])
        assert row is not None
        assert (row.org_id, row.project_id) == (world.org, world.other[0])

    # Its author deletes it from any project of the organization.
    assert await _delete(world.scope(), review["id"]) == {"deleted": True}
    assert await _list(world.scope(world.other)) == []


async def test_another_organization_sees_nothing_of_them(tmp_path):
    from server.authz.principal import Principal
    from server.authz.scope import load_project_scope

    world = await _world(tmp_path)
    review = await _put(world.scope(), comment="org A only")

    eve = _principal("u-3", "Eve", permissions=("org.member.write",))
    assert await _list(world.foreign_scope(), eve) == []
    assert await _list(world.foreign_scope(), eve, server_id="github") == []
    # Not even B's administrator deletes it: it is missing there.
    with pytest.raises(HTTPException) as refused:
        await _delete(world.foreign_scope("owner"), review["id"], eve)
    assert refused.value.status_code == 404

    # The same person writing in B starts B's own review; A's is untouched.
    theirs = await _put(world.foreign_scope(), verdict="safe")
    assert theirs["id"] != review["id"]
    (kept,) = await _list(world.scope())
    assert (kept["id"], kept["verdict"]) == (review["id"], "caution")
    assert [r["id"] for r in await _list(world.foreign_scope())] == [theirs["id"]]

    # B's people cannot name A's project to read A's reviews: the scope is
    # refused as for a project that does not exist.
    outsider = Principal(
        id="u-3",
        email="u-3@x",
        org_id=world.foreign_org,
        permissions=frozenset({"marketplace.read", "project.member.write"}),
    )
    async with _db() as db:
        with pytest.raises(HTTPException) as hidden:
            await load_project_scope(db, outsider, world.project[0])
    assert hidden.value.status_code == 404


async def test_an_unknown_review_is_missing(tmp_path):
    world = await _world(tmp_path)
    with pytest.raises(HTTPException) as missing:
        await _delete(world.scope(), "0" * 8 + "-0000-0000-0000-" + "0" * 12)
    assert missing.value.status_code == 404


async def test_only_its_author_or_an_org_administrator_deletes_a_review(tmp_path):
    world = await _world(tmp_path)
    review = await _put(world.scope())
    bob = _principal("u-2", "Bob")
    with pytest.raises(HTTPException) as refused:
        await _delete(world.scope(), review["id"], bob)
    assert refused.value.status_code == 403
    # Owning one project does not moderate the organization's reviews.
    (as_owner,) = await _list(world.scope(role="owner"), bob)
    assert as_owner["can_delete"] is False
    with pytest.raises(HTTPException) as owner:
        await _delete(world.scope(role="owner"), review["id"], bob)
    assert owner.value.status_code == 403

    admin = _principal("u-2", "Bob", permissions=("org.member.write",))
    assert (await _list(world.scope(role=None), admin))[0]["can_delete"] is True
    assert await _delete(world.scope(role=None), review["id"], admin) == {
        "deleted": True
    }
    assert await _list(world.scope()) == []
    mine = await _put(world.scope())
    assert await _delete(world.scope(), mine["id"]) == {"deleted": True}


async def test_the_list_says_whether_the_caller_may_write(tmp_path):
    world = await _world(tmp_path)
    writer = _principal(permissions=("marketplace.read", "marketplace.write"))
    reader = _principal(permissions=("marketplace.read",))
    assert (await _answer(world.scope(), writer))["can_write"] is True
    assert (await _answer(world.scope(), reader))["can_write"] is False


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


async def test_an_organization_holds_a_bounded_number_of_reviews(tmp_path, monkeypatch):
    import shared_features.mcp_reviews as reviews

    world = await _world(tmp_path)
    monkeypatch.setattr(reviews, "MAX_REVIEWS", 1)
    await _put(world.scope())
    # Replacing one's own review is not a new one.
    await _put(world.scope(), verdict="safe")
    # The bound is the organization's, whichever of its projects writes.
    with pytest.raises(HTTPException) as refused:
        await _put(world.scope(world.other), server_id="sentry")
    assert refused.value.status_code == 422
    assert refused.value.detail == "too_many_reviews"
    # Another organization has its own.
    assert (await _put(world.foreign_scope(), server_id="sentry"))["verdict"]


async def test_a_name_from_the_email_when_there_is_none(tmp_path):
    world = await _world(tmp_path)
    review = await _put(world.scope(), _principal(name=""))
    assert review["author"] == "u-1@x"


def test_timestamps_without_a_zone_read_as_utc():
    from datetime import datetime

    from shared_features.mcp_reviews import _iso

    assert _iso(None) is None
    assert _iso(datetime(2026, 11, 22, 10, 0)) == "2026-11-22T10:00:00+00:00"


def test_the_permission_is_granted_to_maintainers_and_administrators():
    from server.authz.catalog import (
        PERMISSIONS,
        PRIVILEGED_PERMISSION_KEYS,
        SERVER_FEATURES,
        domain_for_feature,
    )
    from server.authz.roles import DEFAULT_ORG_ROLE, LEGACY_ROLE_MAP, system_role
    from shared_features.mcp_reviews import MODERATE, WRITE

    assert WRITE == "marketplace.write" and WRITE in PERMISSIONS
    assert WRITE not in PRIVILEGED_PERMISSION_KEYS
    assert domain_for_feature("mcp_reviews") == "marketplace"
    assert "mcp_reviews" in SERVER_FEATURES
    for slug in ("maintainer", "admin", "owner"):
        assert WRITE in system_role(slug).permissions
    # Members (the default role, and the legacy "member") read only.
    members = {DEFAULT_ORG_ROLE, LEGACY_ROLE_MAP["member"]}
    for slug in (*members, "reviewer", "viewer", "analyst", "operator"):
        assert WRITE not in system_role(slug).permissions
        assert "marketplace.read" in system_role(slug).permissions
    # Deleting anyone's review is an administrator's.
    assert MODERATE in system_role("admin").permissions
    assert MODERATE not in system_role("maintainer").permissions


def _sqlite(db: Path):
    sa = pytest.importorskip("sqlalchemy")
    return sa.create_engine(f"sqlite:///{db}")


def _alembic(tmp_path, monkeypatch):
    pytest.importorskip("alembic")
    from alembic.config import Config

    db = tmp_path / "migrations.sqlite3"
    monkeypatch.setenv("WORKPILOT_DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    return db, Config(str(_BACKEND / "server" / "db" / "alembic.ini"))


def _tables(db: Path) -> set[str]:
    import sqlalchemy as sa

    engine = _sqlite(db)
    try:
        return set(sa.inspect(engine).get_table_names())
    finally:
        engine.dispose()


def _sql(db: Path, *statements: str) -> None:
    import sqlalchemy as sa

    engine = _sqlite(db)
    try:
        with engine.begin() as connection:
            for statement in statements:
                connection.execute(sa.text(statement))
    finally:
        engine.dispose()


def test_the_reviews_table_comes_and_goes_with_its_revision(tmp_path, monkeypatch):
    import sqlalchemy as sa
    from alembic import command

    db, config = _alembic(tmp_path, monkeypatch)
    command.upgrade(config, "head")
    assert "mcp_server_reviews" in _tables(db)
    command.downgrade(config, "0019_login_sessions")
    assert "mcp_server_reviews" not in _tables(db)
    # A table already there (``create_all`` of a newer build) is kept.
    _sql(db, "CREATE TABLE mcp_server_reviews (id VARCHAR(36), org_id VARCHAR(36))")
    command.upgrade(config, "head")
    _sql(db, "DROP TABLE mcp_server_reviews")
    # A table already gone does not stop the downgrade.
    command.downgrade(config, "0019_login_sessions")
    assert "mcp_server_reviews" not in _tables(db)
    command.upgrade(config, "head")
    engine = _sqlite(db)
    try:
        indexes = {
            i["name"] for i in sa.inspect(engine).get_indexes("mcp_server_reviews")
        }
    finally:
        engine.dispose()
    assert "ix_mcp_server_reviews_org" in indexes


def _review_rows(db: Path, *columns: str) -> list[tuple]:
    import sqlalchemy as sa

    engine = _sqlite(db)
    try:
        with engine.connect() as connection:
            return sorted(
                tuple(row)
                for row in connection.execute(
                    sa.text(f"SELECT {', '.join(columns)} FROM mcp_server_reviews")
                )
            )
    finally:
        engine.dispose()


def test_project_reviews_become_their_organizations(tmp_path, monkeypatch):
    from alembic import command

    db, config = _alembic(tmp_path, monkeypatch)
    # Revision 0001 builds today's tables; down and up again, the reviews
    # table is the one 0041 made, as in a database upgraded from it.
    command.upgrade(config, "head")
    command.downgrade(config, "0023_leaderboard_consents")
    command.upgrade(config, "0042_usage_records")
    now = "2026-11-22 10:00:00"
    later = "2026-11-22 11:00:00"
    _sql(
        db,
        *(
            "INSERT INTO organizations (id, name, slug, is_active, created_at) "
            f"VALUES ('{org}', '{org}', '{org}', 1, '{now}')"
            for org in ("org-a", "org-b")
        ),
        *(
            "INSERT INTO users (id, email, display_name, role, is_active, created_at) "
            f"VALUES ('{uid}', '{uid}@x', '{uid}', 'member', 1, '{now}')"
            for uid in ("u-1", "u-2")
        ),
        *(
            "INSERT INTO projects (id, org_id, name, repo_url, default_branch, "
            f"server_path, created_at) VALUES ('{pid}', '{org}', '{pid}', 'x', "
            f"'main', '/srv/{pid}', '{now}')"
            for pid, org in (("p", "org-a"), ("q", "org-a"), ("r", "org-b"))
        ),
        *(
            "INSERT INTO mcp_server_reviews (id, project_id, server_id, author_id, "
            "author_name, verdict, comment, created_at, updated_at) VALUES "
            f"('{rid}', '{pid}', 'github', {author}, 'n', '{verdict}', '', "
            f"'{now}', '{when}')"
            for rid, pid, author, verdict, when in (
                # Ada reviewed github in p, then again in q: q's is the latest.
                ("r-1", "p", "'u-1'", "safe", now),
                ("r-2", "q", "'u-1'", "unsafe", later),
                # Bob in p only; Ada in org B is B's.
                ("r-3", "p", "'u-2'", "caution", now),
                ("r-4", "r", "'u-1'", "safe", now),
                # Authors gone: both kept.
                ("r-5", "p", "NULL", "safe", now),
                ("r-6", "q", "NULL", "safe", now),
            )
        ),
    )

    command.upgrade(config, "0043_mcp_reviews_per_org")
    assert _review_rows(db, "id", "org_id", "project_id", "verdict") == [
        ("r-2", "org-a", "q", "unsafe"),
        ("r-3", "org-a", "p", "caution"),
        ("r-4", "org-b", "r", "safe"),
        ("r-5", "org-a", "p", "safe"),
        ("r-6", "org-a", "q", "safe"),
    ]
    # One review per person, server and organization, held by the database.
    import sqlalchemy as sa

    with pytest.raises(sa.exc.IntegrityError):
        _sql(
            db,
            "INSERT INTO mcp_server_reviews (id, org_id, project_id, server_id, "
            "author_id, author_name, verdict, comment, created_at, updated_at) "
            f"VALUES ('r-7', 'org-a', 'p', 'github', 'u-1', 'n', 'safe', '', "
            f"'{now}', '{now}')",
        )
    # Its project deleted, a review stays with the organization.
    _sql(db, "PRAGMA foreign_keys=ON", "DELETE FROM projects WHERE id = 'r'")
    assert ("r-4", "org-b", None) in _review_rows(db, "id", "org_id", "project_id")

    # Downgraded, each review goes back to the project it came from; one
    # whose project is gone has nowhere to go.
    command.downgrade(config, "0042_usage_records")
    assert _review_rows(db, "id", "project_id") == [
        ("r-2", "q"),
        ("r-3", "p"),
        ("r-5", "p"),
        ("r-6", "q"),
    ]
    # Upgraded again, they are the organization's again.
    command.upgrade(config, "head")
    assert len(_review_rows(db, "org_id")) == 4

    # A database without the table at all gets the new one.
    command.downgrade(config, "0042_usage_records")
    _sql(db, "DROP TABLE mcp_server_reviews")
    command.upgrade(config, "head")
    assert _review_rows(db, "id", "org_id") == []
