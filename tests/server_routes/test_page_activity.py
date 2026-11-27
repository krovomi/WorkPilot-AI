"""Page activity: off by default, turned on per organization, closed page lists.

An organization's administrators turn page activity on once its members are
told (``usage.write``, audited); then each person's desktop and phone send how
many times they opened each page today. A page outside the closed lists
refuses the batch; while it is off nothing is kept; turning it off erases the
organization's counts. Retention is the organization's own when it set one.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from server.services import page_activity
from sqlalchemy import select

from tests.server_routes.world import World

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = "/admin/usage/settings"
PAGES = "/users/me/page-activity"


def today() -> str:
    return datetime.now(UTC).date().isoformat()


async def turn_on(world: World, **extra) -> dict:
    return await world.ok(
        "admin_a", "PUT", SETTINGS, json={"page_activity": True, **extra}
    )


async def send(world: World, who: str, visits: list[dict], client: str = "desktop"):
    return await world.call(
        who, "POST", PAGES, json={"client": client, "visits": visits}
    )


async def counts(world: World) -> list[tuple]:
    from server.db.engine import get_session_factory
    from server.db.models import PageVisit

    async with get_session_factory()() as db:
        return sorted(
            (r.user_id, r.org_id, r.client, r.page, r.count, r.day.isoformat())
            for r in await db.scalars(select(PageVisit))
        )


async def test_page_activity_is_off_until_the_organization_turns_it_on(world):
    settings = await world.ok("admin_a", "GET", SETTINGS)
    assert settings["page_activity"] is False
    assert settings["defaults"] == {
        "usage_retention_days": 365,
        "page_activity_retention_days": 183,
    }
    assert (await world.ok("contributor_a", "GET", PAGES)) == {"enabled": False}
    answer = await send(
        world, "contributor_a", [{"day": today(), "page": "kanban", "count": 3}]
    )
    assert answer.json() == {"enabled": False, "recorded": 0}
    assert await counts(world) == []


async def test_turned_on_the_counts_add_up_per_person_page_and_day(world):
    on = await turn_on(world)
    assert on["page_activity"] is True and on["page_activity_since"]
    assert (await world.ok("contributor_a", "GET", PAGES)) == {"enabled": True}
    yesterday = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
    long_ago = "2020-01-01"
    first = await send(
        world,
        "contributor_a",
        [
            {"day": today(), "page": "kanban", "count": 3},
            {"day": today(), "page": "kanban", "count": 2},
            {"day": yesterday, "page": "roadmap", "count": 1},
            {"day": long_ago, "page": "insights", "count": 9},
        ],
    )
    assert first.json() == {"enabled": True, "recorded": 6}
    await send(
        world,
        "contributor_a",
        [{"day": today(), "page": "projects/cards/detail", "count": 4}],
        client="mobile",
    )
    await send(world, "contributor_a", [{"day": today(), "page": "kanban", "count": 1}])
    uid, org = world.users["contributor_a"], world.orgs["a"]
    assert await counts(world) == sorted(
        [
            (uid, org, "desktop", "kanban", 6, today()),
            (uid, org, "desktop", "roadmap", 1, yesterday),
            (uid, org, "mobile", "projects/cards/detail", 4, today()),
        ]
    )
    # Organization b did not turn it on: its members' counts are not kept.
    other = await send(
        world, "member_b", [{"day": today(), "page": "kanban", "count": 1}]
    )
    assert other.json()["enabled"] is False


async def test_a_page_outside_the_lists_refuses_the_batch(world):
    await turn_on(world)
    for client, page in (
        ("desktop", "projects/cards/detail"),
        ("mobile", "kanban"),
        ("desktop", "kanban/../../etc"),
    ):
        answer = await send(
            world,
            "contributor_a",
            [
                {"day": today(), "page": "roadmap", "count": 1},
                {"day": today(), "page": page, "count": 1},
            ],
            client=client,
        )
        assert answer.status_code == 422
        assert answer.json()["detail"] == "Unknown page"
    assert (await send(world, "contributor_a", [], client="watch")).status_code == 422
    too_many = [{"day": today(), "page": "kanban", "count": 1}] * 201
    assert (await send(world, "contributor_a", too_many)).status_code == 422
    extra = [{"day": today(), "page": "kanban", "count": 1, "project": "p"}]
    assert (await send(world, "contributor_a", extra)).status_code == 422
    assert await counts(world) == []


async def test_turning_it_off_erases_the_organization_s_counts_and_is_audited(world):
    await turn_on(world, page_activity_retention_days=90)
    await send(world, "contributor_a", [{"day": today(), "page": "kanban", "count": 2}])
    off = await world.ok("admin_a", "PUT", SETTINGS, json={"page_activity": False})
    assert off["page_activity"] is False and off["page_activity_since"] is None
    assert await counts(world) == []
    history = await world.ok(
        "admin_a",
        "GET",
        "/admin/audit",
        params={"action": "org.usage_settings.updated"},
    )
    assert [e["payload"].get("page_counts_erased") for e in history] == [1, None]
    assert history[1]["payload"]["after"]["page_activity_retention_days"] == 90
    # Kept on when sent again on: the date it was turned on stays.
    again = await turn_on(world)
    same = await turn_on(world)
    assert same["page_activity_since"] == again["page_activity_since"]


async def test_retention_is_bounded_and_only_administrators_change_it(world):
    too_short = await world.call(
        "admin_a",
        "PUT",
        SETTINGS,
        json={"page_activity": True, "usage_retention_days": 7},
    )
    assert too_short.status_code == 422
    refused = await world.call("analyst_a", "GET", SETTINGS)
    assert refused.status_code == 403
    assert "usage.read" in refused.json()["detail"]
    refused = await world.call(
        "viewer_a", "PUT", SETTINGS, json={"page_activity": True}
    )
    assert refused.status_code == 403


async def test_a_platform_administrator_in_no_organization_sends_nothing(world):
    assert (await world.ok("platform", "GET", PAGES)) == {"enabled": False}
    answer = await send(
        world, "platform", [{"day": today(), "page": "kanban", "count": 1}]
    )
    assert answer.json() == {"enabled": False, "recorded": 0}


async def test_each_organization_keeps_data_as_long_as_it_set(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import Organization, PageVisit, PresenceDay, UsageRecord
    from server.services import usage_retention, usage_settings

    async with get_session_factory()() as db:
        org_a = await db.get(Organization, world.orgs["a"])
        usage_settings.store(
            org_a,
            usage_settings.UsageSettings(
                page_activity=True,
                usage_retention_days=60,
                page_activity_retention_days=30,
            ),
        )
        await db.commit()
    now = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
    rows = []
    for side, who in (("a", "viewer_a"), ("b", "member_b")):
        for age in (40, 100, 200):
            at = now - timedelta(days=age)
            org, uid = world.orgs[side], world.users[who]
            rows += [
                PageVisit(
                    user_id=uid,
                    org_id=org,
                    day=at.date(),
                    client="desktop",
                    page="kanban",
                    count=1,
                ),
                PresenceDay(user_id=uid, org_id=org, day=at.date(), last_seen_at=at),
                UsageRecord(
                    org_id=org,
                    user_id=uid,
                    phase="coding",
                    created_at=at,
                ),
            ]
    async with get_session_factory()() as db:
        db.add_all(rows)
        await db.commit()
    erased = await usage_retention.sweep(now)
    # a: usage 60 days (100 and 200 go), pages 30 days (all three go);
    # b: the server's 365 and 183 days (only the 200-day pages go).
    assert erased == {"usage_records": 2, "presence_days": 2, "page_visits": 4}
    async with get_session_factory()() as db:
        left = sorted(
            (r.org_id == world.orgs["a"], (now.date() - r.day).days)
            for r in await db.scalars(select(PageVisit))
        )
    assert left == [(False, 40), (False, 100)]


async def test_a_racing_batch_of_the_same_person_is_read_again(world, monkeypatch):
    from server.db.engine import get_session_factory

    await turn_on(world)
    calls = []
    real = page_activity._add

    async def first_collides(db, *args):
        calls.append(1)
        if len(calls) == 1:
            from sqlalchemy.exc import IntegrityError

            raise IntegrityError("INSERT", {}, Exception("unique"))
        return await real(db, *args)

    monkeypatch.setattr(page_activity, "_add", first_collides)
    async with get_session_factory()() as db:
        recorded = await page_activity.record(
            db,
            user_id=world.users["viewer_a"],
            org_id=world.orgs["a"],
            client="desktop",
            visits=[page_activity.Visit(date(2026, 11, 22), "kanban", 2)],
            today=date(2026, 11, 22),
        )
    assert recorded == 2 and len(calls) == 2


async def test_a_batch_that_collides_twice_is_refused(world, monkeypatch):
    import pytest
    from server.db.engine import get_session_factory
    from sqlalchemy.exc import IntegrityError

    async def collides(db, *args):
        raise IntegrityError("INSERT", {}, Exception("unique"))

    monkeypatch.setattr(page_activity, "_add", collides)
    async with get_session_factory()() as db:
        with pytest.raises(IntegrityError):
            await page_activity.record(
                db,
                user_id=world.users["viewer_a"],
                org_id=world.orgs["a"],
                client="desktop",
                visits=[page_activity.Visit(date(2026, 11, 22), "kanban", 2)],
                today=date(2026, 11, 22),
            )


def test_stored_settings_that_are_not_settings_read_as_the_default():
    from server.services import usage_settings

    assert usage_settings.of(None) == usage_settings.UsageSettings()
    assert usage_settings.of({"usage": "on"}) == usage_settings.UsageSettings()
    odd = usage_settings.of(
        {
            "usage": {
                "page_activity": "yes",
                "page_activity_since": 3,
                "usage_retention_days": True,
                "page_activity_retention_days": 5,
            }
        }
    )
    assert odd == usage_settings.UsageSettings(page_activity_retention_days=30)


def test_the_lists_are_the_apps_own_screens():
    """Every desktop view and every phone screen has its name in the list."""
    sidebar = (ROOT / "apps/frontend/src/renderer/components/Sidebar.tsx").read_text(
        encoding="utf-8"
    )
    union = sidebar[sidebar.index("export type SidebarView =") :]
    views = set(re.findall(r'"([a-z0-9-]+)"', union[: union.index(";")]))
    assert views == page_activity.DESKTOP_PAGES
    shared = (ROOT / "apps/frontend/src/shared/constants/page-activity.ts").read_text(
        encoding="utf-8"
    )
    assert set(re.findall(r'^\t"([a-z0-9-]+)",$', shared, re.M)) == views
    mobile = (ROOT / "apps/mobile/src/usage/pages.ts").read_text(encoding="utf-8")
    assert (
        set(re.findall(r'^\t"([a-z/]+)",$', mobile, re.M)) == page_activity.MOBILE_PAGES
    )
