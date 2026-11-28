"""The usage report: its figures, its sends at the organization's hour, and
its routes.

Yesterday and the day before are laid down for organization A (tokens, runs,
a budget, one merged task), with a bit of B's to prove it stays out. The
scheduler is then run at chosen moments: a report goes once, a server back
after the hour still sends it the same day, and without SMTP the claim says
so. The routes read and change the settings, read the report, and send it now.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta

import pytest
from server.services import usage_digest, usage_report_schedule
from server.services.usage_digest import Period
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from tests.server_routes.world import World

SETTINGS = "/admin/usage/report/settings"
REPORT = "/admin/usage/report"
SEND = "/admin/usage/report/send"
NOON = datetime.combine(datetime.now(UTC).date(), datetime.min.time(), UTC).replace(
    hour=12
)
YESTERDAY = (NOON - timedelta(days=1)).date()


@pytest.fixture
async def days(world: World, monkeypatch) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, OrgQuota, PresenceDay, SpecIndex, UsageRecord
    from server.services import presence

    async def unnoted(*_args, **_kwargs) -> bool:
        return False

    monkeypatch.setattr(presence, "touch", unnoted)
    u, a, b = world.users, world.orgs["a"], world.orgs["b"]
    pa = world.projects["a"]
    at = NOON - timedelta(days=1)
    async with get_session_factory()() as db:
        spec = SpecIndex(project_id=pa, spec_name="001-x", created_by=u["owner_a"])
        db.add(spec)
        await db.flush()
        for phase, status, when, error in (
            ("coding", "succeeded", at, None),
            ("merge", "succeeded", at, None),
            ("qa", "failed", at, "the runner timed out"),
            ("coding", "succeeded", at - timedelta(days=1), None),
        ):
            db.add(
                AgentRun(
                    spec_id=spec.id,
                    phase=phase,
                    status=status,
                    started_by=u["contributor_a"],
                    started_at=when,
                    finished_at=when + timedelta(minutes=1),
                    error=error,
                )
            )
        for who, org, tokens, when in (
            ("contributor_a", a, 6000, at),
            ("viewer_a", a, 3000, at),
            ("contributor_a", a, 1000, at - timedelta(days=1)),
            ("member_b", b, 99_999, at),
        ):
            db.add(
                UsageRecord(
                    org_id=org,
                    project_id=pa if org == a else world.projects["b"],
                    user_id=u[who],
                    phase="coding",
                    provider="anthropic",
                    model="claude-x",
                    input_tokens=tokens,
                    output_tokens=0,
                    cost_micro_usd=tokens * 100,
                    created_at=when,
                )
            )
        db.add(
            PresenceDay(
                user_id=u["contributor_a"], org_id=a, day=YESTERDAY, last_seen_at=at
            )
        )
        db.add(OrgQuota(org_id=a, monthly_token_budget=100_000))
        await db.commit()


def smtp(monkeypatch) -> list:
    """Turn SMTP on; the messages it would send."""
    from server import config
    from server.services import email

    monkeypatch.setenv("WORKPILOT_SMTP_HOST", "smtp.corp.example")
    monkeypatch.setenv("WORKPILOT_SMTP_FROM", "workpilot@corp.example")
    config.reset_settings_cache()
    sent: list = []
    monkeypatch.setattr(email, "_send_sync", lambda _settings, msg: sent.append(msg))
    return sent


async def _org_settings(world: World, side: str, **values) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import Organization

    async with get_session_factory()() as db:
        org = await db.get(Organization, world.orgs[side])
        org.settings = {**(org.settings or {}), "usage_report": values}
        await db.commit()


def _ours(world: World, done: list[dict]) -> list[dict]:
    """The sends of A and B, without the server's default organization."""
    return [d for d in done if d["org_id"] in world.orgs.values()]


async def _audits(action: str) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    async with get_session_factory()() as db:
        rows = await db.scalars(select(AuditLog).where(AuditLog.action == action))
        return [r.payload for r in rows]


async def test_the_report_compares_each_figure(world, days):
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        period = Period("daily", YESTERDAY, YESTERDAY)
        report = await usage_digest.digest(db, world.orgs["a"], period)
        blind = await usage_digest.digest(db, world.orgs["a"], period, names=False)
    figures = report["figures"]
    assert report["organization"] == "Acme" and report["kind"] == "daily"
    assert figures["tokens"]["value"] == 9000
    assert figures["tokens"]["previous"] == 1000
    assert figures["tokens"]["average"] == pytest.approx(1000 / 7, rel=1e-3)
    assert figures["runs"]["value"] == 3 and figures["failed"]["value"] == 1
    assert figures["active"]["value"] == 1
    assert [p["name"] for p in report["top"]] == ["contributor_a", "viewer_a"]
    assert [p["name"] for p in blind["top"]] == [None, None]
    assert report["engines"][0]["model"] == "claude-x"
    assert report["failures"][0]["cause"] == "timeout"
    assert report["budget"]["monthly_token_budget"] == 100_000
    weekly = await _weekly(world)
    assert weekly["figures"]["tokens"]["average"] is None


async def _weekly(world: World) -> dict:
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        period = usage_digest.period_containing("weekly", YESTERDAY)
        return await usage_digest.digest(db, world.orgs["a"], period)


async def test_without_smtp_the_claim_says_so_and_nothing_goes_twice(world, days):
    first = await usage_report_schedule.tick(NOON)
    assert {d["status"] for d in first} == {"no_smtp"}
    assert set(world.orgs.values()) <= {d["org_id"] for d in first}
    assert (
        _ours(world, await usage_report_schedule.tick(NOON + timedelta(minutes=1)))
        == []
    )
    (audit, *_) = await _audits(usage_report_schedule.SENT)
    assert set(audit) == {"kind", "period", "status", "recipients"}
    assert audit["period"] == YESTERDAY.isoformat()


async def test_the_report_goes_once_to_its_readers_and_after_a_restart(
    world, days, monkeypatch
):
    sent = smtp(monkeypatch)
    await _org_settings(world, "a", time="09:00", timezone="UTC")
    await _org_settings(world, "b", enabled=False)
    early = NOON.replace(hour=8)
    assert _ours(world, await usage_report_schedule.tick(early)) == []
    # The server was down at 9:00 and comes back at noon: the report goes.
    (done,) = _ours(world, await usage_report_schedule.tick(NOON))
    assert done["status"] == "sent" and len(sent) == 1
    to = sent[0]["To"]
    assert "owner_a@example.com" in to and "admin_a@example.com" in to
    assert "viewer_a@example.com" not in to
    assert "Acme" in sent[0]["Subject"]
    assert _ours(world, await usage_report_schedule.tick(NOON.replace(hour=18))) == []
    assert len(sent) == 1


async def test_chosen_recipients_a_failed_send_and_nobody_to_send_to(
    world, days, monkeypatch
):
    from server.db.engine import get_session_factory
    from server.db.models import Organization, User

    sent = smtp(monkeypatch)
    await _org_settings(
        world, "a", timezone="UTC", recipients=["boss@corp.example"], weekly=True
    )
    await _org_settings(world, "b", timezone="UTC")
    async with get_session_factory()() as db:
        admin = await db.get(User, world.users["admin_b"])
        admin.is_active = False
        await db.commit()
    monday = NOON - timedelta(days=NOON.weekday())
    done = await usage_report_schedule.tick(monday)
    by = {(d["org_id"], d["kind"]): d["status"] for d in done}
    assert by[(world.orgs["a"], "daily")] == "sent"
    assert by[(world.orgs["a"], "weekly")] == "sent"
    assert by[(world.orgs["b"], "daily")] == "no_recipient"
    assert all(m["To"] == "boss@corp.example" for m in sent)

    def refused(_settings, _msg):
        raise OSError("connection refused")

    from server.services import email

    monkeypatch.setattr(email, "_send_sync", refused)
    async with get_session_factory()() as db:
        b = await db.get(Organization, world.orgs["b"])
        b.is_active = False
        await db.commit()
    (failed, *rest) = _ours(
        world, await usage_report_schedule.tick(monday + timedelta(days=1))
    )
    assert failed["status"] == "failed" and rest == []
    async with get_session_factory()() as db:
        sends = await usage_report_schedule.last_sends(db, world.orgs["a"])
    assert sends[0]["status"] == "failed" and sends[0]["recipients"] == 1


async def test_a_period_is_claimed_only_once(world):
    from server.db.engine import get_session_factory

    period = Period("daily", date(2026, 1, 1), date(2026, 1, 1))
    async with get_session_factory()() as db:
        assert await usage_report_schedule._claim(db, world.orgs["a"], period)
        assert not await usage_report_schedule._claim(db, world.orgs["a"], period)


async def test_the_loop_survives_a_database_error_and_stops(world, caplog):
    await usage_report_schedule.stop()
    calls: list[int] = []

    async def ready() -> None:
        calls.append(1)
        if len(calls) == 1:
            raise OperationalError("SELECT 1", {}, Exception("down"))

    with caplog.at_level(logging.WARNING):
        task = usage_report_schedule.start(ready=ready, interval=0.01)
        assert usage_report_schedule.start(ready=ready) is task
        for _ in range(200):
            if len(calls) >= 2:
                break
            await asyncio.sleep(0.01)
        await usage_report_schedule.stop()
    assert len(calls) >= 2 and task.done()
    assert "Usage report tick failed: OperationalError" in caplog.text
    await usage_report_schedule.stop()


async def test_the_settings_read_with_their_defaults(world, days):
    await usage_report_schedule.tick(NOON)
    got = await world.ok("admin_a", "GET", SETTINGS)
    assert got["enabled"] and got["time"] == "09:00" and got["recipients"] == []
    assert got["email_enabled"] is False
    assert "owner_a@example.com" in got["default_recipients"]
    assert got["last_sends"][0]["status"] == "no_smtp"


async def test_changing_the_settings_flags_outsiders_and_audits(world):
    body = {
        "enabled": True,
        "time": "07:30",
        "timezone": "America/New_York",
        "days": [4, 0, 0],
        "recipients": [" Viewer_A@example.com", "boss@corp.example"],
        "language": "en",
        "names": False,
        "weekly": True,
        "monthly": False,
    }
    got = await world.ok("admin_a", "PUT", SETTINGS, json=body)
    assert got["days"] == [0, 4] and got["time"] == "07:30"
    assert got["recipients"] == [
        {"address": "viewer_a@example.com", "member": True},
        {"address": "boss@corp.example", "member": False},
    ]
    (changed,) = await _audits("usage.report.recipients_changed")
    assert changed == {
        "added": ["viewer_a@example.com", "boss@corp.example"],
        "removed": [],
    }
    (updated,) = await _audits("usage.report.settings_updated")
    assert "recipients" not in updated["after"]
    assert updated["after"]["timezone"] == "America/New_York"
    await world.ok("admin_a", "PUT", SETTINGS, json=body)
    assert len(await _audits("usage.report.settings_updated")) == 1
    fewer = {**body, "recipients": ["boss@corp.example"]}
    await world.ok("admin_a", "PUT", SETTINGS, json=fewer)
    assert (await _audits("usage.report.recipients_changed"))[-1] == {
        "added": [],
        "removed": ["viewer_a@example.com"],
    }
    assert len(await _audits("usage.report.settings_updated")) == 1
    again = await world.ok("admin_a", "GET", SETTINGS)
    assert again["language"] == "en" and again["names"] is False


@pytest.mark.parametrize(
    "change",
    [
        {"time": "24:00"},
        {"timezone": "Nowhere/City"},
        {"days": [7]},
        {"days": []},
        {"recipients": ["not an address"]},
        {"recipients": [f"p{i}@corp.example" for i in range(21)]},
        {"language": "de"},
        {"extra": 1},
    ],
)
async def test_a_setting_that_does_not_read_is_refused(world, change):
    body = {
        "enabled": True,
        "time": "09:00",
        "timezone": "UTC",
        "days": [0],
        "recipients": [],
        "language": "fr",
        "names": True,
        "weekly": False,
        "monthly": False,
        **change,
    }
    answer = await world.call("admin_a", "PUT", SETTINGS, json=body)
    assert answer.status_code == 422


async def test_the_report_reads_in_the_app_for_any_past_period(world, days):
    last = await world.ok("admin_a", "GET", REPORT)
    assert last["kind"] == "daily" and last["figures"]["tokens"]["value"] >= 0
    held = await world.ok(
        "admin_a", "GET", REPORT, params={"kind": "daily", "day": str(YESTERDAY)}
    )
    assert held["start"] == str(YESTERDAY)
    assert held["figures"]["tokens"]["value"] == 9000
    month = await world.ok(
        "admin_a", "GET", REPORT, params={"kind": "monthly", "day": "2026-02-10"}
    )
    assert (month["start"], month["end"]) == ("2026-02-01", "2026-02-28")
    future = str(datetime.now(UTC).date() + timedelta(days=2))
    answer = await world.call("admin_a", "GET", REPORT, params={"day": future})
    assert answer.status_code == 422
    wrong = await world.call("admin_a", "GET", REPORT, params={"kind": "yearly"})
    assert wrong.status_code == 422


async def test_send_now_needs_smtp_then_goes_and_is_audited(world, days, monkeypatch):
    answer = await world.call("admin_a", "POST", SEND)
    assert answer.status_code == 409
    sent = smtp(monkeypatch)
    got = await world.ok("admin_a", "POST", SEND)
    assert got["status"] == "sent" and got["recipients"] >= 2 and len(sent) == 1
    (audit,) = await _audits("usage.report.sent_now")
    assert audit["status"] == "sent" and "To" not in audit
    # A send now is not the day's scheduled send.
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        assert await usage_report_schedule.last_sends(db, world.orgs["a"]) == []


async def test_an_organization_gone_answers_404(world, monkeypatch):
    from fastapi import HTTPException
    from server.routers import usage_report as routes

    class Nothing:
        async def get(self, *_args):
            return None

    with pytest.raises(HTTPException) as refused:
        await routes._org(Nothing(), "gone")  # type: ignore[arg-type]
    assert refused.value.status_code == 404


async def test_the_server_sends_reports_for_its_lifetime(world, monkeypatch):
    started: list[object] = []
    real_start = usage_report_schedule.start

    def spy(ready=None, interval=usage_report_schedule.INTERVAL_SECONDS):
        started.append(ready)
        return real_start(ready=ready, interval=3600)

    monkeypatch.setattr(usage_report_schedule, "start", spy)
    async with world.app.router.lifespan_context(world.app):
        assert usage_report_schedule._task is not None
        assert not usage_report_schedule._task.done()
    assert usage_report_schedule._task is None
    assert len(started) == 1 and started[0] is not None


async def test_a_message_without_smtp_is_refused():
    from email.message import EmailMessage

    from server.services import email

    with pytest.raises(email.EmailError):
        await email.send_message(EmailMessage())


async def test_an_erased_account_leaves_the_report_s_recipients(world):
    from server.db.engine import get_session_factory
    from server.db.models import Organization
    from server.services import report_settings

    await _org_settings(
        world,
        "a",
        recipients=["contributor_a@example.com", "boss@corp.example"],
    )
    await _org_settings(world, "b", recipients=["boss@corp.example"])
    who = world.users["contributor_a"]
    done = await world.ok(
        "platform",
        "POST",
        f"/admin/users/{who}/erase",
        json={"confirm_email": "contributor_a@example.com"},
    )
    assert done["report_recipients_removed"] == 1
    async with get_session_factory()() as db:
        a = await db.get(Organization, world.orgs["a"])
        b = await db.get(Organization, world.orgs["b"])
        assert report_settings.of(a.settings).recipients == ("boss@corp.example",)
        assert report_settings.of(b.settings).recipients == ("boss@corp.example",)
