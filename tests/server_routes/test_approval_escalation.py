"""Escalating a plan that waited too long for its approvals.

On the seeded deployment (``world.py``): project A's organization has an
owner (``owner_a``, on the project) and an administrator (``admin_a``, not on
it, who still approves there through the organization's role), the second
group by default. The wait is a spec run's end, written as the run manager
writes it; the sweep is called directly, its loop and its place in the app's
lifespan are tested apart. Nothing leaves the test: the channels post to a
mock transport through a fixed public resolver.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography.fernet import Fernet

from tests.server_routes.test_spec_quorum_routes import (
    approve,
    card_dir,
    new_card,
    set_criticality,
    settings,
)
from tests.server_routes.world import World

_BOT = "123:" + "x" * 24  # an obvious fake, in the shape the validator accepts
NOW = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)


async def _public(host: str) -> list[str]:
    return ["93.184.216.34"]


def turn_on(monkeypatch, **values: str | None) -> None:
    settings(
        monkeypatch,
        needs_you_enabled="1",
        secrets_master_key=Fernet.generate_key().decode(),
        **{"approval_escalation_hours": "24", **values},
    )


async def spec_ran(world: World, card_id: str, hours_ago: float, **run) -> str:
    """A spec run of the card that ended ``hours_ago`` before :data:`NOW`."""
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, SpecIndex
    from sqlalchemy import select

    ended = NOW - timedelta(hours=hours_ago)
    async with get_session_factory()() as db:
        spec_id = await db.scalar(
            select(SpecIndex.id).where(SpecIndex.spec_name == card_id)
        )
        row = AgentRun(
            spec_id=spec_id,
            phase=run.get("phase", "spec"),
            status=run.get("status", "succeeded"),
            started_at=ended - timedelta(minutes=5),
            finished_at=ended,
        )
        db.add(row)
        await db.commit()
        return row.id


async def channel(world: World, who: str, chat_id: str, **preferences) -> None:
    from server.db.engine import get_session_factory
    from server.services import needs_you

    async with get_session_factory()() as db:
        await needs_you.save_channel(
            db, world.users[who], "telegram", {"bot_token": _BOT, "chat_id": chat_id}
        )
        if preferences:
            await needs_you.save_preferences(
                db, world.users[who], preferences["events"], preferences["locale"]
            )


async def sweep(sent: list[httpx.Request], now: datetime = NOW) -> int:
    from server.services import approval_escalation

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"ok": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await approval_escalation.sweep(now=now, client=client, resolver=_public)


async def escalations(world: World) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import ApprovalEscalation, AuditLog
    from sqlalchemy import select

    async with get_session_factory()() as db:
        rows = list(await db.scalars(select(ApprovalEscalation)))
        audit = list(
            await db.scalars(
                select(AuditLog).where(AuditLog.action == "review.escalated")
            )
        )
    return [rows, audit]


def chats(sent: list[httpx.Request]) -> list[str]:
    return sorted(json.loads(r.content)["chat_id"] for r in sent)


async def test_off_unless_the_deployment_sets_a_wait(world, monkeypatch):
    from server.services import approval_escalation

    settings(monkeypatch, needs_you_enabled="1")
    card = await new_card(world, "contributor_a")
    await spec_ran(world, card, hours_ago=500)
    assert await sweep([]) == 0
    assert approval_escalation.start() is None


async def test_a_plan_that_waited_too_long_reaches_the_second_group(world, monkeypatch):
    turn_on(monkeypatch)
    card = await new_card(world, "contributor_a")
    run = await spec_ran(world, card, hours_ago=25)
    await channel(world, "owner_a", "1")
    await channel(world, "admin_a", "2", events={}, locale="fr")
    # An approver who is not in the second group is not told.
    await channel(world, "maintainer_a", "3")

    sent: list[httpx.Request] = []
    assert await sweep(sent) == 1
    assert chats(sent) == ["1", "2"]
    texts = {
        json.loads(r.content)["chat_id"]: json.loads(r.content)["text"] for r in sent
    }
    assert texts["1"].startswith("A plan waits for an approver\nProject A, card")
    assert texts["2"].startswith("Un plan attend un approbateur\nProject A, carte")
    # Never the card's title.
    assert "Card of" not in texts["1"]

    rows, audit = await escalations(world)
    assert [(r.run_id, r.spec_name, r.notified) for r in rows] == [(run, card, 2)]
    assert audit[0].payload["recipients"] == 2
    assert audit[0].payload["waited_hours"] == 25
    assert audit[0].org_id == world.orgs["a"]

    # Once per wait.
    again: list[httpx.Request] = []
    assert await sweep(again, NOW + timedelta(hours=5)) == 0 and again == []


async def test_a_new_spec_run_starts_a_new_wait(world, monkeypatch):
    turn_on(monkeypatch)
    card = await new_card(world, "contributor_a")
    await spec_ran(world, card, hours_ago=50)
    assert await sweep([]) == 1
    await spec_ran(world, card, hours_ago=1)
    assert await sweep([]) == 0
    assert await sweep([], NOW + timedelta(hours=24)) == 1


async def test_not_before_the_wait_of_its_criticality(world, monkeypatch):
    turn_on(monkeypatch, approval_escalation_hours="high=4,medium=0")
    medium = await new_card(world, "contributor_a")
    await spec_ran(world, medium, hours_ago=300)
    high = await new_card(world, "contributor_a")
    assert (await set_criticality(world, "owner_a", high, "high")).status_code == 200
    await spec_ran(world, high, hours_ago=3)
    assert await sweep([]) == 0
    assert await sweep([], NOW + timedelta(hours=1, minutes=1)) == 1
    rows, _ = await escalations(world)
    assert [(r.spec_name, r.criticality) for r in rows] == [(high, "high")]


async def test_an_approved_card_or_one_built_on_does_not_escalate(world, monkeypatch):
    turn_on(monkeypatch)
    approved = await new_card(world, "contributor_a")
    await spec_ran(world, approved, hours_ago=30)
    assert (await approve(world, "reviewer_a", approved)).json()["approved"] is True
    built = await new_card(world, "contributor_a")
    await spec_ran(world, built, hours_ago=30)
    await spec_ran(world, built, hours_ago=29, phase="build", status="running")
    unreviewed = await new_card(world, "contributor_a")
    metadata = card_dir(world, "a", unreviewed) / "task_metadata.json"
    data = json.loads(metadata.read_text(encoding="utf-8"))
    metadata.write_text(
        json.dumps({**data, "requireReviewBeforeCoding": False}), encoding="utf-8"
    )
    await spec_ran(world, unreviewed, hours_ago=30)
    failed = await new_card(world, "contributor_a")
    await spec_ran(world, failed, hours_ago=30, status="failed")
    assert await sweep([]) == 0
    assert (await escalations(world))[0] == []


async def test_an_approval_short_of_the_quorum_still_escalates(world, monkeypatch):
    turn_on(monkeypatch, approval_quorum="medium=2")
    card = await new_card(world, "contributor_a")
    await spec_ran(world, card, hours_ago=30)
    assert (await approve(world, "owner_a", card)).json()["approved"] is False
    await channel(world, "owner_a", "1")
    await channel(world, "admin_a", "2")
    sent: list[httpx.Request] = []
    assert await sweep(sent) == 1
    # The owner already approved this version: only the administrator hears.
    assert chats(sent) == ["2"]


async def test_the_second_group_leaves_out_the_author(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import Project
    from server.services.approval_escalation import second_group

    turn_on(monkeypatch, approval_escalation_roles="owner+maintainer")
    card = await new_card(world, "maintainer_a")
    async with get_session_factory()() as db:
        project = await db.get(Project, world.projects["a"])
        people = await second_group(
            db,
            project=project,
            spec_name=card,
            card_dir=card_dir(world, "a", card),
            author_id=world.users["maintainer_a"],
        )
    assert people == [world.users["owner_a"]]


async def test_a_muted_moment_or_sending_off_tells_nobody(world, monkeypatch):
    turn_on(monkeypatch)
    card = await new_card(world, "contributor_a")
    await spec_ran(world, card, hours_ago=30)
    await channel(
        world, "owner_a", "1", events={"approval_escalated": False}, locale="en"
    )
    sent: list[httpx.Request] = []
    assert await sweep(sent) == 1 and sent == []

    settings(monkeypatch, needs_you_enabled=None)
    other = await new_card(world, "contributor_a")
    await spec_ran(world, other, hours_ago=30)
    assert await sweep(sent) == 1 and sent == []
    rows, audit = await escalations(world)
    assert sorted(r.notified for r in rows) == [0, 0]
    assert [a.payload["recipients"] for a in audit] == [2, 2]


async def test_the_loop_survives_a_failed_sweep_and_stops(world, monkeypatch):
    from server.services import approval_escalation
    from sqlalchemy.exc import OperationalError

    turn_on(monkeypatch)
    turns: list[int] = []
    readied: list[int] = []

    async def flaky(**_: object) -> int:
        turns.append(1)
        if len(turns) == 1:
            raise OperationalError("SELECT", {}, Exception("locked"))
        return 0

    async def ready() -> None:
        readied.append(1)

    monkeypatch.setattr(approval_escalation, "sweep", flaky)
    task = approval_escalation.start(ready=ready, interval=0.001)
    assert task is not None
    assert approval_escalation.start(ready=ready) is task
    for _ in range(200):
        if len(turns) >= 3:
            break
        await asyncio.sleep(0.005)
    await approval_escalation.stop()
    assert len(turns) >= 3 and len(readied) >= 3
    assert task.cancelled()
    await approval_escalation.stop()  # Nothing running: nothing to do.

    # Without a readiness check, the loop sweeps straight away.
    task = approval_escalation.start(interval=0.001)
    for _ in range(200):
        if len(turns) >= 4:
            break
        await asyncio.sleep(0.005)
    await approval_escalation.stop()
    assert len(turns) >= 4


async def test_the_server_runs_it_for_its_lifetime(world, monkeypatch):
    from server.services import approval_escalation

    turn_on(monkeypatch)
    started: list[object] = []
    real_start = approval_escalation.start

    def spy(ready=None, interval=approval_escalation.INTERVAL_SECONDS):
        started.append(ready)
        return real_start(ready=ready, interval=3600)

    monkeypatch.setattr(approval_escalation, "start", spy)
    async with world.app.router.lifespan_context(world.app):
        assert approval_escalation._task is not None
        assert not approval_escalation._task.done()
    assert approval_escalation._task is None
    assert len(started) == 1 and started[0] is not None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", (("low", 0), ("medium", 0), ("high", 0))),
        ("24", (("low", 24), ("medium", 24), ("high", 24))),
        ("low=72, high=4", (("low", 72), ("medium", 0), ("high", 4))),
        ("high=999,medium=x", (("low", 0), ("medium", 0), ("high", 0))),
    ],
)
def test_the_waits_as_the_operator_writes_them(value, expected):
    from server import config as server_config

    assert server_config._escalation_hours(value) == expected


def test_the_second_group_as_the_operator_names_it():
    from server import config as server_config

    assert server_config._escalation_roles("") == ("owner", "admin")
    assert server_config._escalation_roles("Tech-Lead + security,tech-lead") == (
        "tech-lead",
        "security",
    )
    assert server_config._escalation_roles("Bad Slug") == ("owner", "admin")
    assert (
        len(server_config._escalation_roles("+".join(f"r{i}" for i in range(9)))) == 5
    )


async def test_nothing_is_sent_for_an_unknown_moment_or_while_off(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.services import needs_you

    async with get_session_factory()() as db:
        assert await needs_you.notify_people(db, ["x"], "plan_review", "P", "001") == 0
        turn_on(monkeypatch)
        assert await needs_you.notify_people(db, ["x"], "other", "P", "001") == 0
        # Someone with no channel.
        assert await needs_you.notify_people(db, ["x"], "plan_review", "P", "001") == 0
