"""The approval policy's pieces: settings, criticality, content, ledger edges.

The routes are in ``tests/server_routes/test_spec_quorum_routes.py`` and
``test_approval_delegation_routes.py``; these hold what the routes do not
reach on their own: malformed settings, unreadable files, a race.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from server import config as server_config


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for key in list(os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def test_the_quorum_is_one_unless_set(caplog):
    assert server_config._approval_quorum("") == (
        ("low", 1),
        ("medium", 1),
        ("high", 1),
    )
    quorum = dict(server_config._approval_quorum(" High=3, medium = 2 ,,urgent=9,low"))
    assert quorum == {"low": 1, "medium": 2, "high": 3}
    assert "urgent=9" in caplog.text and "'low'" in caplog.text
    for bad in ("high=0", "high=11", "high=two"):
        assert dict(server_config._approval_quorum(bad))["high"] == 1
    assert "Invalid WORKPILOT_APPROVAL_QUORUM" in caplog.text


def test_the_roles_are_slugs(caplog):
    roles = dict(
        server_config._approval_roles("high=Tech-Lead + security++tech-lead+Bad Slug")
    )
    assert roles == {"low": (), "medium": (), "high": ("tech-lead", "security")}
    assert "Bad Slug" in caplog.text
    many = dict(
        server_config._approval_roles("low=" + "+".join(f"r{i}" for i in range(9)))
    )
    assert len(many["low"]) == 5


def test_the_settings_read_both(monkeypatch):
    monkeypatch.setenv("WORKPILOT_APPROVAL_QUORUM", "high=2")
    monkeypatch.setenv("WORKPILOT_APPROVAL_ROLES", "high=security")
    from server.authz.approval_policy import requirement_for

    assert requirement_for("high").needed == 2
    assert requirement_for("high").roles == ("security",)
    assert requirement_for("low").needed == 1


def test_what_the_assessment_may_say(tmp_path, monkeypatch):
    from server.authz import approval_policy as policy

    assessment = tmp_path / "complexity_assessment.json"
    assert policy.assessed_criticality(None) is None
    assert policy.assessed_criticality(tmp_path) is None
    for content, expected in (
        ({"complexity": "complex"}, "high"),
        ({"complexity": "simple"}, "low"),
        ({"complexity": 3}, None),
        (["complex"], None),
    ):
        assessment.write_text(json.dumps(content), encoding="utf-8")
        assert policy.assessed_criticality(tmp_path) == expected
    assessment.write_text("{not json", encoding="utf-8")
    assert policy.assessed_criticality(tmp_path) is None
    assessment.write_text(" " * (policy._ASSESSMENT_LIMIT + 1), encoding="utf-8")
    assert policy.assessed_criticality(tmp_path) is None

    # A link is not read: it could name any file of the server.
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps({"complexity": "complex"}), encoding="utf-8")
    assessment.unlink()
    assessment.symlink_to(elsewhere)
    assert policy.assessed_criticality(tmp_path) is None
    assert policy.effective_criticality("bogus", tmp_path) == ("medium", "default")
    assert policy.effective_criticality("low", tmp_path) == ("low", "set")


def test_the_content_an_approval_covers(tmp_path, monkeypatch):
    from server.authz.approval_policy import content_hash

    empty = content_hash(tmp_path)
    (tmp_path / "spec.md").write_text("# A", encoding="utf-8")
    spec_only = content_hash(tmp_path)
    assert spec_only != empty
    (tmp_path / "implementation_plan.json").write_text("{}", encoding="utf-8")
    assert content_hash(tmp_path) != spec_only
    # Moving bytes from one file to the other is another content.
    (tmp_path / "spec.md").write_text("# A{", encoding="utf-8")
    (tmp_path / "implementation_plan.json").write_text("}", encoding="utf-8")
    assert content_hash(tmp_path) != spec_only

    def unreadable(self):
        raise OSError("gone")

    monkeypatch.setattr(Path, "read_bytes", unreadable)
    assert content_hash(tmp_path) == empty


def test_a_naive_moment_is_utc():
    from server.authz.delegation import aware

    naive = datetime(2026, 1, 1, 12, 0)
    assert aware(naive) == datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    paris = datetime(2026, 1, 1, 13, 0, tzinfo=UTC) + timedelta(hours=0)
    assert aware(paris).tzinfo == UTC


def test_whose_approval_a_person_gives():
    from server.authz.principal import Principal

    approver = Principal(id="a", permissions=frozenset({"review.approve"}))
    assert approver.approval_slot("p") == "a"
    delegate = Principal(id="d", delegations=(("p", "a"),))
    assert delegate.approval_slot("p") == "a"
    assert delegate.approval_slot("q") is None
    assert delegate.acting_for(None) is None


async def _database(tmp_path, monkeypatch):
    from server.db import engine as db_engine

    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "p.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    monkeypatch.setattr(db_engine, "_engine", None)
    monkeypatch.setattr(db_engine, "_session_factory", None)
    await db_engine.init_db()
    return db_engine


async def test_a_race_for_the_same_place_records_one(tmp_path, monkeypatch):
    from server.authz import approvals
    from server.db.models import Organization, Project, SpecApproval, User
    from sqlalchemy import func, select

    db_engine = await _database(tmp_path, monkeypatch)
    card = tmp_path / "card"
    card.mkdir()
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="a")
        db.add_all([org, User(id="u", email="u@x.invalid", display_name="U")])
        await db.flush()
        db.add(Project(id="p", org_id=org.id, name="P", repo_url="r", server_path="s"))
        await db.commit()
        org_id = org.id

    async def record(db) -> bool:
        return await approvals.record_approval(
            db,
            project_id="p",
            org_id=org_id,
            spec_name="001-x",
            card_dir=card,
            person_id="u",
            slot_id="u",
            criticality="medium",
        )

    async with db_engine.get_session_factory()() as db:
        assert await record(db) is True
        await db.commit()

    class Racing:
        """A session that missed the row another request just wrote."""

        def __init__(self, db):
            self._db = db

        async def scalar(self, *_args, **_kwargs):
            return None

        def __getattr__(self, name):
            return getattr(self._db, name)

    async with db_engine.get_session_factory()() as db:
        assert await record(Racing(db)) is False
        count = await db.scalar(select(func.count()).select_from(SpecApproval))
    assert count == 1
    await db_engine.dispose_engine()


async def test_nobody_s_approval_is_not_given(tmp_path):
    from server.authz.principal import Principal
    from server.authz.scope import ProjectScope
    from shared_board.approvals import give_approval

    scope = ProjectScope("p", "o", tmp_path, "member")
    assert (
        await give_approval(None, scope, Principal(id="x"), tmp_path, None, None)
        is None
    )


async def test_an_unknown_person_holds_no_approval(tmp_path, monkeypatch):
    from server.authz.self_approval import holds_approval

    db_engine = await _database(tmp_path, monkeypatch)
    async with db_engine.get_session_factory()() as db:
        assert not await holds_approval(db, project_id="p", org_id="o", user_id="nope")
    await db_engine.dispose_engine()


async def test_roles_come_from_the_organization_groups_and_project(
    tmp_path, monkeypatch
):
    from server.authz.approvals import role_slugs
    from server.db.models import (
        GroupMember,
        Organization,
        OrgMember,
        Project,
        ProjectMember,
        Role,
        User,
        UserGroup,
    )

    db_engine = await _database(tmp_path, monkeypatch)
    async with db_engine.get_session_factory()() as db:
        org = Organization(id="o", name="A", slug="a")
        user = User(id="u", email="u@x.invalid", display_name="U")
        db.add_all([org, user])
        await db.flush()
        roles = {
            slug: Role(
                id=slug, org_id="o", slug=slug, name=slug, scope="org", permissions=[]
            )
            for slug in ("dev", "security", "lead")
        }
        db.add_all(roles.values())
        db.add(Project(id="p", org_id="o", name="P", repo_url="r", server_path="s"))
        await db.flush()
        db.add(OrgMember(org_id="o", user_id="u", role_id="dev"))
        db.add(UserGroup(id="g", org_id="o", name="Sec", role_id="security"))
        await db.flush()
        db.add(GroupMember(group_id="g", user_id="u"))
        db.add(
            ProjectMember(project_id="p", user_id="u", role="member", role_id="lead")
        )
        await db.commit()
        assert await role_slugs(db, user_id="u", org_id="o", project_id="p") == [
            "dev",
            "lead",
            "security",
        ]
        assert await role_slugs(db, user_id="nobody", org_id="o", project_id="p") == []
    await db_engine.dispose_engine()
