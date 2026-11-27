"""A person's own usage: what administrators see of them, their export, the
notice of what is measured, and the erasure of an account."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from tests.server_routes.world import World

NOTICE = "/users/me/usage-notice"


@pytest.fixture
async def used(world: World) -> datetime:
    """A little of everything about contributor_a, and some of others."""
    from server.db.engine import get_session_factory
    from server.db.models import (
        AgentRun,
        AuditLog,
        Invitation,
        PageVisit,
        PresenceDay,
        ProjectJob,
        SpecIndex,
        UsageRecord,
    )

    now = datetime.now(UTC)
    u, a, pa = world.users, world.orgs["a"], world.projects["a"]
    async with get_session_factory()() as db:
        spec = SpecIndex(
            project_id=pa, spec_name="001-x", created_by=u["contributor_a"]
        )
        db.add(spec)
        await db.flush()
        db.add(
            AgentRun(
                spec_id=spec.id,
                phase="coding",
                status="succeeded",
                started_by=u["contributor_a"],
                started_at=now - timedelta(hours=3),
            )
        )
        db.add(
            ProjectJob(
                project_id=pa,
                feature="roadmap",
                status="succeeded",
                started_by=u["contributor_a"],
            )
        )
        for who, tokens in (("contributor_a", 700), ("viewer_a", 50)):
            db.add(
                UsageRecord(
                    org_id=a,
                    project_id=pa,
                    user_id=u[who],
                    phase="coding",
                    provider="anthropic",
                    model="claude-x",
                    input_tokens=tokens,
                    cost_micro_usd=1_000_000,
                    created_at=now - timedelta(hours=2),
                )
            )
        db.add(
            PresenceDay(
                user_id=u["contributor_a"], org_id=a, day=now.date(), last_seen_at=now
            )
        )
        db.add(
            PageVisit(
                user_id=u["contributor_a"],
                org_id=a,
                day=now.date(),
                client="mobile",
                page="home",
                count=2,
            )
        )
        db.add(
            AuditLog(
                user_id=u["contributor_a"],
                org_id=a,
                action="auth.login.local",
                ip="10.0.0.7",
                user_agent="WorkPilot/1.6",
                login_method="local",
                created_at=now - timedelta(hours=1),
            )
        )
        db.add(
            AuditLog(
                user_id=u["admin_a"],
                org_id=a,
                action="project.member.added",
                payload={"member": "Contributor_A@Example.com", "role": "member"},
            )
        )
        db.add(
            AuditLog(
                user_id=u["admin_a"],
                org_id=a,
                action="org.group.member_added",
                payload={
                    "user_id": u["contributor_a"],
                    "nested": [u["contributor_a"], 3],
                },
            )
        )
        db.add(
            Invitation(
                email="CONTRIBUTOR_A@example.com",
                org_id=a,
                token_hash="i" * 64,
                expires_at=now + timedelta(days=1),
            )
        )
        await db.commit()
    return now


async def _email(world: World, who: str) -> str:
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        return (await db.get(User, world.users[who])).email


async def test_a_person_sees_what_administrators_see_of_them(world, used):
    mine = await world.ok("contributor_a", "GET", "/users/me/usage")
    assert mine["user"]["user_id"] == world.users["contributor_a"]
    assert mine["summary"]["tokens"]["total"] == 700
    assert (
        mine["summary"]["runs"]["total"] == 1 and mine["summary"]["jobs"]["total"] == 1
    )
    assert {e["kind"] for e in mine["timeline"]} == {"sign_in", "run", "job"}
    assert mine["pages"]["pages"][0]["page"] == "home"
    assert mine["daily"][0]["tokens"] == 700
    assert mine["visible_to"] == ["Administrator", "Owner"]
    # Filters name only the caller: another person's id changes nothing.
    other = await world.ok(
        "contributor_a",
        "GET",
        "/users/me/usage",
        params={"user_id": world.users["viewer_a"]},
    )
    assert other["summary"]["tokens"]["total"] == 700
    nowhere = await world.call("platform", "GET", "/users/me/usage")
    assert nowhere.status_code == 400


async def test_a_custom_role_with_usage_read_is_named(world, used):
    from server.db.engine import get_session_factory
    from server.db.models import Role

    async with get_session_factory()() as db:
        db.add(
            Role(
                org_id=world.orgs["a"],
                slug="auditor",
                name="Auditor",
                permissions=["usage.read"],
            )
        )
        db.add(
            Role(
                org_id=world.orgs["b"],
                slug="spy",
                name="Spy",
                permissions=["usage.read"],
            )
        )
        await db.commit()
    mine = await world.ok("contributor_a", "GET", "/users/me/usage")
    assert mine["visible_to"] == ["Administrator", "Auditor", "Owner"]


async def test_a_person_exports_everything_kept_about_them(world, used):
    answer = await world.call("contributor_a", "GET", "/users/me/usage/export")
    assert answer.status_code == 200
    assert answer.headers["content-type"].startswith("application/json")
    assert "workpilot-my-usage-" in answer.headers["content-disposition"]
    data = json.loads(answer.text)
    assert data["account"]["id"] == world.users["contributor_a"]
    assert data["account"]["organizations"][0]["organization"]
    assert [r["input_tokens"] for r in data["usage"]] == [700]
    assert data["usage"][0]["cost_usd"] == 1.0 and data["usage"][0]["project"]
    assert len(data["presence"]) >= 1
    assert data["pages"] == [
        {
            "day": used.date().isoformat(),
            "organization": data["usage"][0]["organization"],
            "app": "mobile",
            "page": "home",
            "opens": 2,
        }
    ]
    login = next(e for e in data["audit"] if e["action"] == "auth.login.local")
    assert login["ip"] == "10.0.0.7" and login["login_method"] == "local"
    assert [r["phase"] for r in data["runs"]] == ["coding"]
    assert [r["feature"] for r in data["jobs"]] == ["roadmap"]
    # Others' rows never come in.
    assert all(e["action"] != "project.member.added" for e in data["audit"])


async def test_an_erased_account_cannot_read_or_export(world, used):
    from server.db.engine import get_session_factory
    from server.db.models import User

    token = await world.token("contributor_a")
    async with get_session_factory()() as db:
        await db.delete(await db.get(User, world.users["contributor_a"]))
        await db.commit()
    headers = {"Authorization": f"Bearer {token}"}
    export = await world.client.get("/users/me/usage/export", headers=headers)
    assert (export.status_code, export.json()["detail"]) == (404, "Account not found")
    # No membership left either: no organization to read the usage of.
    assert (
        await world.client.get("/users/me/usage", headers=headers)
    ).status_code == 400


async def test_the_notice_is_due_until_read_and_again_once_pages_count(world, used):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    first = await world.ok("contributor_a", "GET", NOTICE)
    assert first["due"] is True and first["page_activity"] is False
    assert "tokens" in first["measured"]
    assert first["usage_retention_days"] == 365
    assert first["visible_to"] == ["Administrator", "Owner"]
    assert (await world.ok("contributor_a", "POST", NOTICE))["due"] is False
    assert (await world.ok("contributor_a", "GET", NOTICE))["due"] is False
    await world.ok("contributor_a", "POST", NOTICE)  # not due: nothing more recorded

    await world.ok(
        "admin_a", "PUT", "/admin/usage/settings", json={"page_activity": True}
    )
    again = await world.ok("contributor_a", "GET", NOTICE)
    assert again["due"] is True and again["page_activity"] is True
    await world.ok("contributor_a", "POST", NOTICE)
    assert (await world.ok("contributor_a", "GET", NOTICE))["due"] is False
    # Someone else, or another organization, still has it due.
    assert (await world.ok("viewer_a", "GET", NOTICE))["due"] is True
    assert (await world.ok("member_b", "GET", NOTICE))["due"] is True

    async with get_session_factory()() as db:
        seen = (
            await db.scalars(
                select(AuditLog.payload)
                .where(AuditLog.action == "usage.notice.seen")
                .order_by(AuditLog.created_at)
            )
        ).all()
    assert seen == [{"page_activity": False}, {"page_activity": True}]


async def test_a_notice_read_with_an_odd_payload_counts_as_read(world, used):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    async with get_session_factory()() as db:
        db.add(
            AuditLog(
                user_id=world.users["contributor_a"],
                org_id=world.orgs["a"],
                action="usage.notice.seen",
                payload=None,
            )
        )
        await db.commit()
    assert (await world.ok("contributor_a", "GET", NOTICE))["due"] is False


async def test_the_platform_erases_an_account_and_keeps_the_totals(world, used):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog, Invitation, UsageRecord, User

    who = world.users["contributor_a"]
    email = await _email(world, "contributor_a")
    url = f"/admin/users/{who}/erase"
    for actor, body, status, detail in (
        (
            "platform",
            {"confirm_email": "someone@else.com"},
            400,
            "The address does not match the account",
        ),
        ("platform", {"confirm_email": email, "extra": 1}, 422, None),
    ):
        answer = await world.call(actor, "POST", url, json=body)
        assert answer.status_code == status
        if detail:
            assert answer.json()["detail"] == detail
    me = world.users["platform"]
    own = await world.call(
        "platform", "POST", f"/admin/users/{me}/erase", json={"confirm_email": "x@y.z"}
    )
    assert (own.status_code, own.json()["detail"]) == (
        400,
        "You cannot erase your own account",
    )
    gone = await world.call(
        "platform",
        "POST",
        "/admin/users/00000000-0000-4000-8000-000000000000/erase",
        json={"confirm_email": "x@y.z"},
    )
    assert (gone.status_code, gone.json()["detail"]) == (404, "User not found")

    done = await world.ok(
        "platform", "POST", url, json={"confirm_email": f"  {email.upper()} "}
    )
    assert done == {
        "erased": True,
        "audit_entries_cleared": 1,
        "audit_payloads_scrubbed": 2,
        "invitations_deleted": 1,
    }
    async with get_session_factory()() as db:
        assert await db.get(User, who) is None
        records = (await db.scalars(select(UsageRecord))).all()
        assert sorted(r.input_tokens for r in records) == [50, 700]
        assert all(r.user_id != who for r in records)
        login = await db.scalar(
            select(AuditLog).where(AuditLog.action == "auth.login.local")
        )
        assert (login.user_id, login.ip, login.user_agent) == (None, None, None)
        added = await db.scalar(
            select(AuditLog).where(AuditLog.action == "project.member.added")
        )
        assert added.payload == {"member": "erased", "role": "member"}
        grouped = await db.scalar(
            select(AuditLog).where(AuditLog.action == "org.group.member_added")
        )
        assert grouped.payload == {"user_id": "erased", "nested": ["erased", 3]}
        assert await db.scalar(select(func.count(Invitation.id))) == 0
        entry = await db.scalar(
            select(AuditLog).where(AuditLog.action == "user.erased")
        )
        assert entry.user_id == me
        assert email not in json.dumps(entry.payload) and who not in json.dumps(
            entry.payload
        )
    people = await world.ok("admin_a", "GET", "/admin/usage/people")
    anonymous = next(r for r in people if r["user_id"] is None)
    assert anonymous["tokens"] == 700 and anonymous["name"] is None
