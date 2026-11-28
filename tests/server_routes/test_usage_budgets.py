"""Monthly token budgets per person, group and project, and their alerts.

Organization A's month so far: contributor_a used 6 000 tokens on its
project, viewer_a 3 000, grouped_a (of the group « Devs ») 500, and
contributor_a 9 000 more last month, which no budget counts. Organization B
used some too, to prove it stays out.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from server.services import quotas, usage_budgets, usage_digest, usage_digest_mail
from server.services.report_settings import ReportSettings
from sqlalchemy import select

from tests.server_routes.world import World

BUDGETS = "/admin/usage/budgets"
NOW = datetime.now(UTC)


@pytest.fixture
async def month(world: World) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import UsageRecord

    u, a, b = world.users, world.orgs["a"], world.orgs["b"]
    first = NOW.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    async with get_session_factory()() as db:
        for who, org, project, tokens, at in (
            ("contributor_a", a, world.projects["a"], 6000, NOW),
            ("viewer_a", a, None, 3000, NOW),
            ("grouped_a", a, None, 500, NOW),
            ("contributor_a", a, world.projects["a"], 9000, first - timedelta(days=1)),
            ("member_b", b, world.projects["b"], 50_000, NOW),
        ):
            db.add(
                UsageRecord(
                    org_id=org,
                    project_id=project,
                    user_id=u[who],
                    phase="coding",
                    provider="anthropic",
                    model="claude-x",
                    input_tokens=tokens,
                    output_tokens=0,
                    cost_micro_usd=0,
                    created_at=min(at, datetime.now(UTC)),
                )
            )
        await db.commit()


def smtp(monkeypatch) -> list:
    from server import config
    from server.services import email

    monkeypatch.setenv("WORKPILOT_SMTP_HOST", "smtp.corp.example")
    monkeypatch.setenv("WORKPILOT_SMTP_FROM", "workpilot@corp.example")
    config.reset_settings_cache()
    sent: list = []
    monkeypatch.setattr(email, "_send_sync", lambda _settings, msg: sent.append(msg))
    return sent


async def _set(world: World, scope: str, target: str, tokens: int, block=False):
    return await world.ok(
        "admin_a",
        "PUT",
        BUDGETS,
        json={
            "scope": scope,
            "target_id": target,
            "monthly_tokens": tokens,
            "block": block,
        },
    )


async def _audits(action: str) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    async with get_session_factory()() as db:
        rows = await db.scalars(select(AuditLog).where(AuditLog.action == action))
        return [r.payload for r in rows]


async def _own_budget(world: World, tokens: int, hard: bool = False) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import OrgQuota

    async with get_session_factory()() as db:
        db.add(
            OrgQuota(
                org_id=world.orgs["a"],
                monthly_token_budget=tokens,
                enforce_hard_stop=hard,
            )
        )
        await db.commit()


async def test_budgets_are_set_read_and_removed(world, month):
    empty = await world.ok("admin_a", "GET", BUDGETS)
    assert empty == {"organization": None, "budgets": [], "alerts": []}
    await _own_budget(world, 100_000, hard=True)
    u = world.users
    await _set(world, "person", u["contributor_a"], 5000, block=True)
    await _set(world, "group", world.group, 1000)
    got = await _set(world, "project", world.projects["a"], 20_000)
    assert got["organization"]["used"] == 9500
    assert got["organization"]["block"] is True
    by = {b["scope"]: b for b in got["budgets"]}
    assert by["person"]["used"] == 6000 and by["person"]["percent"] == 120.0
    assert by["person"]["name"] == "contributor_a" and by["person"]["block"]
    assert by["group"]["used"] == 500 and by["group"]["name"] == "Devs"
    assert by["project"]["used"] == 6000
    again = await _set(world, "person", u["contributor_a"], 8000)
    person = next(b for b in again["budgets"] if b["scope"] == "person")
    assert person["monthly_tokens"] == 8000 and not person["block"]
    changes = await _audits(usage_budgets_router().SET)
    assert changes[0]["before"] is None
    assert changes[-1]["before"] == {"monthly_tokens": 5000, "block": True}
    assert changes[-1]["target_id"] == u["contributor_a"]
    left = await world.ok("admin_a", "DELETE", f"{BUDGETS}/{person['id']}")
    assert {b["scope"] for b in left["budgets"]} == {"group", "project"}
    (removed,) = await _audits(usage_budgets_router().REMOVED)
    assert removed["before"] == {"monthly_tokens": 8000, "block": False}


def usage_budgets_router():
    from server.routers import usage_budgets as routes

    return routes


@pytest.mark.parametrize(
    ("scope", "target"),
    [
        ("person", "member_b"),
        ("person", "nobody-at-all"),
        ("group", "nobody-at-all"),
        ("project", "b"),
    ],
)
async def test_a_target_outside_the_organization_is_not_found(world, scope, target):
    if scope == "person" and target in world.users:
        target = world.users[target]
    elif scope == "project" and target in world.projects:
        target = world.projects[target]
    answer = await world.call(
        "admin_a",
        "PUT",
        BUDGETS,
        json={"scope": scope, "target_id": target, "monthly_tokens": 10},
    )
    assert answer.status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"scope": "team", "target_id": "x", "monthly_tokens": 10},
        {"scope": "person", "target_id": "x", "monthly_tokens": 0},
        {"scope": "person", "target_id": "x", "monthly_tokens": 10**13},
        {"scope": "person", "target_id": "", "monthly_tokens": 10},
        {"scope": "person", "target_id": "x", "monthly_tokens": "10"},
        {"scope": "person", "target_id": "x", "monthly_tokens": 10, "extra": 1},
    ],
)
async def test_a_budget_that_does_not_read_is_refused(world, body):
    answer = await world.call("admin_a", "PUT", BUDGETS, json=body)
    assert answer.status_code == 422


async def test_another_organization_s_budget_is_not_found(world, month):
    from server.db.engine import get_session_factory
    from server.db.models import UsageBudget

    async with get_session_factory()() as db:
        theirs = UsageBudget(
            org_id=world.orgs["b"],
            scope="person",
            target_id=world.users["member_b"],
            monthly_tokens=10,
        )
        db.add(theirs)
        await db.commit()
    for budget_id in (theirs.id, "missing"):
        answer = await world.call("admin_a", "DELETE", f"{BUDGETS}/{budget_id}")
        assert answer.status_code == 404
    mine = await world.ok("admin_a", "GET", BUDGETS)
    assert mine["budgets"] == []


async def test_a_spent_blocking_budget_refuses_runs(world, month):
    from server.db.engine import get_session_factory

    u, a = world.users, world.orgs["a"]
    await _set(world, "person", u["contributor_a"], 5000, block=True)
    await _set(world, "group", world.group, 400, block=True)
    await _set(world, "project", world.projects["a"], 7000, block=True)
    await _set(world, "person", u["viewer_a"], 100)
    async with get_session_factory()() as db:
        for user, project in (
            (u["contributor_a"], None),
            (u["grouped_a"], None),
        ):
            with pytest.raises(HTTPException) as refused:
                await quotas.enforce_run_quota(db, a, user, project)
            assert refused.value.status_code == 402
        # Not blocking: only alerts.
        await quotas.enforce_run_quota(db, a, u["viewer_a"], None)
        await quotas.enforce_run_quota(db, a, u["owner_a"], world.projects["a"])
        await quotas.enforce_run_quota(db, a, None, None)
    await _set(world, "project", world.projects["a"], 6000, block=True)
    async with get_session_factory()() as db:
        with pytest.raises(HTTPException) as refused:
            await quotas.enforce_run_quota(db, a, u["owner_a"], world.projects["a"])
        assert "project" in refused.value.detail


async def test_each_alert_goes_once_a_month(world, month, monkeypatch):
    from server.db.engine import get_session_factory

    sent = smtp(monkeypatch)
    u, a = world.users, world.orgs["a"]
    await _own_budget(world, 11_000)
    await _set(world, "person", u["contributor_a"], 5000, block=True)
    await _set(world, "group", world.group, 600)
    await _set(world, "project", world.projects["a"], 100_000)
    settings = ReportSettings(language="en", names=False)
    to = ["boss@corp.example"]
    async with get_session_factory()() as db:
        raised = await usage_budgets.check(db, a, "Acme", settings, to)
        assert sorted((r["scope"], r["threshold"]) for r in raised) == [
            ("group", 80),
            ("org", 80),
            ("person", 100),
        ]
        assert await usage_budgets.check(db, a, "Acme", settings, to) == []
        alerts = await usage_budgets.last_alerts(db, a)
    subjects = sorted(m["Subject"] for m in sent)
    assert any("a person's monthly token budget" in s for s in subjects)
    assert any("the group Devs" in s for s in subjects)
    assert any("the organization Acme" in s for s in subjects)
    person = next(m for m in sent if "a person" in m["Subject"])
    assert "New runs are refused" in person.get_content()
    assert "contributor_a" not in person.get_content()
    # The person's 80 % is claimed with their 100 %, never sent after it.
    assert sorted((x["scope"], x["threshold"]) for x in alerts) == [
        ("group", 80),
        ("org", 80),
        ("person", 80),
        ("person", 100),
    ]
    assert {x["recipients"] for x in alerts if x["scope"] == "group"} == {1}
    audits = await _audits(usage_budgets.ALERT)
    assert len(audits) == 3 and all("boss" not in str(x) for x in audits)


async def test_alerts_without_smtp_or_when_it_fails(world, month, monkeypatch):
    from server.db.engine import get_session_factory
    from server.services import email

    u, a = world.users, world.orgs["a"]
    await _set(world, "person", u["contributor_a"], 5000)
    async with get_session_factory()() as db:
        raised = await usage_budgets.check(db, a, "Acme", ReportSettings(), ["x@y.z"])
        assert raised == [{"scope": "person", "threshold": 100}]
    smtp(monkeypatch)

    def refused(_settings, _msg):
        raise OSError("refused")

    monkeypatch.setattr(email, "_send_sync", refused)
    await _set(world, "person", u["viewer_a"], 3500)
    async with get_session_factory()() as db:
        await usage_budgets.check(db, a, "Acme", ReportSettings(), ["x@y.z"])
        alerts = await usage_budgets.last_alerts(db, a)
    assert {x["recipients"] for x in alerts} == {0}


async def test_a_target_gone_from_the_organization_drops_its_budget(world, month):
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember, UsageBudget

    u = world.users
    await _set(world, "person", u["viewer_a"], 5000)
    await _set(world, "person", u["analyst_a"], 5000)
    async with get_session_factory()() as db:
        member = await db.scalar(
            select(OrgMember).where(
                OrgMember.org_id == world.orgs["a"], OrgMember.user_id == u["viewer_a"]
            )
        )
        await db.delete(member)
        await db.commit()
    got = await world.ok("admin_a", "GET", BUDGETS)
    assert [b["target_id"] for b in got["budgets"]] == [u["analyst_a"]]
    async with get_session_factory()() as db:
        left = (await db.scalars(select(UsageBudget))).all()
        assert [b.target_id for b in left] == [u["analyst_a"]]


async def test_an_erased_account_loses_its_budget(world, month):
    u = world.users
    await _set(world, "person", u["viewer_a"], 5000)
    done = await world.ok(
        "platform",
        "POST",
        f"/admin/users/{u['viewer_a']}/erase",
        json={"confirm_email": "viewer_a@example.com"},
    )
    assert done["budgets_removed"] == 1
    assert (await world.ok("admin_a", "GET", BUDGETS))["budgets"] == []


async def test_the_daily_report_lists_the_budgets_past_their_threshold(world, month):
    from server.db.engine import get_session_factory

    u, a = world.users, world.orgs["a"]
    await _set(world, "person", u["contributor_a"], 5000)
    await _set(world, "group", world.group, 600)
    await _set(world, "project", world.projects["a"], 7000)
    await _set(world, "person", u["viewer_a"], 100_000)
    period = usage_digest.period_containing("daily", NOW.date())
    async with get_session_factory()() as db:
        named = await usage_digest.digest(db, a, period)
        blind = await usage_digest.digest(db, a, period, names=False)
    scoped = [x for x in named["alerts"] if x["kind"] == "budget_scope"]
    assert sorted((x["scope"], x["threshold"]) for x in scoped) == [
        ("group", 80),
        ("person", 100),
        ("project", 80),
    ]
    fr = usage_digest_mail.lines(named, "fr")["alerts"]
    assert (
        "contributor_a : 120,0 % de son budget mensuel de tokens (seuil de 100 %)."
        in fr
    )
    assert any(line.startswith("Groupe Devs : ") for line in fr)
    en = usage_digest_mail.lines(blind, "en")["alerts"]
    assert any(line.startswith("A person: 120.0 %") for line in en)
    assert any(line.startswith("Project ") for line in en)


def test_the_alert_email_in_french_names_or_not():
    status = usage_budgets.Status("k", "person", "u", "Ada", 1000, True, 1500)
    named = usage_budgets.alert_message(
        status,
        100,
        ReportSettings(language="fr"),
        "Acme",
        "w@x.example",
        ["a@x.example"],
    )
    assert named["Subject"] == (
        "WorkPilot : 150.0 % du budget mensuel de tokens de Ada"
    )
    body = named.get_content()
    assert body.startswith("Ada a utilisé 1 500 tokens sur 1 000")
    assert "Les nouveaux runs sont refusés" in body
    quiet = usage_budgets.alert_message(
        status, 80, ReportSettings(language="de", names=False), "Acme", "w", ["a"]
    )
    assert "une personne" in quiet["Subject"]
    assert quiet.get_content().startswith("Une personne")
    assert "refusés" not in quiet.get_content()
    project = usage_budgets.Status("k", "project", "p", "Site", 10, False, 9)
    assert project.percent == 90.0
    assert project.as_dict()["id"] == "k"
    assert (
        usage_budgets.Status("org", "org", None, None, 10, False, 1).as_dict()["id"]
        is None
    )


async def test_a_run_is_refused_before_it_is_queued(world, month, tmp_path):
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, SpecIndex
    from server.services.run_manager import get_run_manager

    u = world.users
    await _set(world, "person", u["contributor_a"], 5000, block=True)
    async with get_session_factory()() as db:
        spec = SpecIndex(
            project_id=world.projects["a"],
            spec_name="001-x",
            created_by=u["contributor_a"],
        )
        db.add(spec)
        await db.commit()
    manager = get_run_manager()
    with pytest.raises(HTTPException) as refused:
        await manager.start_run(
            spec,
            world.projects["a"],
            str(tmp_path),
            "build",
            u["contributor_a"],
            org_id=world.orgs["a"],
        )
    assert refused.value.status_code == 402
    assert spec.id not in manager._running_specs
    async with get_session_factory()() as db:
        assert (await db.scalars(select(AgentRun))).all() == []
