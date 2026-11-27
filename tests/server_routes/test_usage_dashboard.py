"""The Usage tab's figures, as an organization's administrator reads them.

One organization's month is laid down (runs, jobs, the tokens they used, who
was there, which pages they opened, a sign-in, an invitation), with a bit of
the other organization's to prove it stays out. Each view is then read
through the real routes, filters included; the platform's twin sees both.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from server.services import usage_delivery, usage_report
from sqlalchemy import select

from tests.server_routes.world import World

BASE = "/admin/usage"
PLATFORM = "/admin/platform/usage"


@pytest.fixture
async def month(world: World, monkeypatch) -> dict:
    """The organization A's last days, and one record of B's.

    The administrators reading the figures would count as present today
    themselves: their own requests note nothing here.
    """
    from server.services import presence

    async def unnoted(*_args, **_kwargs) -> bool:
        return False

    monkeypatch.setattr(presence, "touch", unnoted)
    from server.db.engine import get_session_factory
    from server.db.models import (
        AgentRun,
        AuditLog,
        Invitation,
        OrgMember,
        OrgQuota,
        PageVisit,
        PresenceDay,
        ProjectJob,
        SpecIndex,
        UsageRecord,
        User,
    )

    now = datetime.now(UTC)
    u = world.users
    a, b = world.orgs["a"], world.orgs["b"]
    pa, pb = world.projects["a"], world.projects["b"]
    async with get_session_factory()() as db:
        spec = SpecIndex(
            project_id=pa,
            spec_name="001-login",
            created_by=u["contributor_a"],
            created_at=now - timedelta(days=3),
        )
        db.add(spec)
        await db.flush()

        def run(phase, status, who, days, error=None, provider=None, model=None):
            row = AgentRun(
                spec_id=spec.id,
                phase=phase,
                status=status,
                started_by=u[who],
                started_at=now - timedelta(days=days),
                finished_at=now - timedelta(days=days) + timedelta(minutes=5),
                error=error,
                provider=provider,
                model=model,
            )
            db.add(row)
            return row

        coding = run(
            "coding", "succeeded", "contributor_a", 2, None, "anthropic", "claude-x"
        )
        qa = run("qa", "failed", "contributor_a", 2, "Rate limit reached (429)")
        run("merge", "succeeded", "contributor_a", 1)
        run("coding", "failed", "grouped_a", 1, "pytest: 3 tests failed")
        job = ProjectJob(
            project_id=pa,
            feature="roadmap",
            started_by=u["viewer_a"],
            status="failed",
            error="the runner timed out",
            started_at=now - timedelta(days=1),
        )
        db.add(job)
        await db.flush()

        def used(who, org, project, phase, provider, model, tokens, cost, **extra):
            db.add(
                UsageRecord(
                    org_id=org,
                    project_id=project,
                    user_id=u[who] if who else None,
                    phase=phase,
                    provider=provider,
                    model=model,
                    input_tokens=tokens[0],
                    output_tokens=tokens[1],
                    cost_micro_usd=cost,
                    created_at=now - timedelta(days=extra.pop("days", 2)),
                    **extra,
                )
            )

        used(
            "contributor_a",
            a,
            pa,
            "coding",
            "anthropic",
            "claude-x",
            (1000, 500),
            2_000_000,
            run_id=coding.id,
        )
        used(
            "contributor_a",
            a,
            pa,
            "qa",
            "openai",
            "gpt-y",
            (200, 100),
            500_000,
            run_id=qa.id,
        )
        used(
            "viewer_a",
            a,
            pa,
            "roadmap",
            "anthropic",
            "claude-x",
            (100, 0),
            100_000,
            job_id=job.id,
            estimated=True,
            days=1,
        )
        used(None, a, None, "coding", "anthropic", "claude-x", (10, 0), 1)
        used("member_b", b, pb, "coding", "anthropic", "claude-x", (9999, 0), 9_000_000)

        old = now - timedelta(days=60)
        for who in ("contributor_a", "viewer_a", "analyst_a"):
            member = await db.scalar(
                select(OrgMember).where(
                    OrgMember.org_id == a, OrgMember.user_id == u[who]
                )
            )
            member.created_at = old
        db.add(
            PresenceDay(
                user_id=u["contributor_a"], org_id=a, day=now.date(), last_seen_at=now
            )
        )
        db.add(
            PresenceDay(
                user_id=u["viewer_a"],
                org_id=a,
                day=(now - timedelta(days=40)).date(),
                last_seen_at=now - timedelta(days=40),
            )
        )
        db.add(
            PresenceDay(
                user_id=u["member_b"], org_id=b, day=now.date(), last_seen_at=now
            )
        )
        db.add(
            PageVisit(
                user_id=u["contributor_a"],
                org_id=a,
                day=now.date(),
                client="desktop",
                page="kanban",
                count=3,
            )
        )
        db.add(
            PageVisit(
                user_id=u["viewer_a"],
                org_id=a,
                day=now.date(),
                client="desktop",
                page="kanban",
                count=1,
            )
        )
        db.add(
            PageVisit(
                user_id=u["member_b"],
                org_id=b,
                day=now.date(),
                client="mobile",
                page="home",
                count=5,
            )
        )
        db.add(
            AuditLog(
                user_id=u["contributor_a"],
                org_id=a,
                action="auth.login.local",
                created_at=now - timedelta(hours=1),
            )
        )
        db.add(
            AuditLog(
                user_id=u["contributor_a"],
                org_id=a,
                action="spec.claimed",
                payload={"x": 1},
                created_at=now - timedelta(hours=2),
            )
        )
        db.add(
            Invitation(
                email="new@example.com",
                org_id=a,
                token_hash="h" * 64,
                expires_at=now + timedelta(days=7),
                accepted_at=now,
            )
        )
        db.add(OrgQuota(org_id=a, monthly_token_budget=10_000))
        stranger = await db.get(User, u["stranger_a"])
        stranger.display_name = '=HYPERLINK("http://x")'
        await db.commit()
    return {"now": now, "spec": spec.id}


async def test_the_key_figures_are_the_organization_s_own(world, month):
    figures = await world.ok("admin_a", "GET", f"{BASE}/summary")
    assert figures["tokens"]["total"] == 1000 + 500 + 200 + 100 + 100 + 10
    assert figures["tokens"]["input"] == 1310
    assert figures["cost_usd"] == pytest.approx(2.600001)
    assert figures["sessions"] == 4 and figures["estimated"] is True
    assert figures["runs"] == {
        "total": 4,
        "succeeded": 2,
        "failed": 2,
        "cancelled": 0,
        "success_rate": 0.5,
    }
    assert figures["jobs"]["failed"] == 1 and figures["jobs"]["success_rate"] == 0.0
    assert figures["active"] == {"day": 1, "week": 1, "month": 1}
    assert figures["budget"]["monthly_token_budget"] == 10_000
    assert figures["budget"]["percent"] is not None
    # The default period is the last 30 days, today included.
    today = month["now"].date()
    assert figures["end"] == today.isoformat()
    assert figures["start"] == (today - timedelta(days=29)).isoformat()


async def test_the_filters_narrow_every_figure(world, month):
    by_openai = await world.ok(
        "admin_a", "GET", f"{BASE}/summary", params={"provider": "openai"}
    )
    assert by_openai["tokens"]["total"] == 300
    assert by_openai["runs"]["total"] == 1 and by_openai["jobs"]["total"] == 0
    by_model = await world.ok(
        "admin_a", "GET", f"{BASE}/summary", params={"model": "claude-x"}
    )
    assert by_model["runs"]["total"] == 1 and by_model["jobs"]["total"] == 1
    grouped = await world.ok(
        "admin_a", "GET", f"{BASE}/summary", params={"group_id": world.group}
    )
    assert grouped["runs"]["total"] == 1 and grouped["tokens"]["total"] == 0
    person = await world.ok(
        "admin_a", "GET", f"{BASE}/summary", params={"user_id": world.users["viewer_a"]}
    )
    assert person["jobs"]["total"] == 1 and person["active"]["month"] == 0
    project = await world.ok(
        "admin_a", "GET", f"{BASE}/summary", params={"project_id": world.projects["a"]}
    )
    assert project["tokens"]["total"] == 1900
    long_ago = await world.ok(
        "admin_a",
        "GET",
        f"{BASE}/summary",
        params={"start": "2020-01-01", "end": "2020-01-31"},
    )
    assert long_ago["tokens"]["total"] == 0 and long_ago["runs"]["total"] == 0


async def test_a_filter_from_elsewhere_or_a_period_out_of_bounds_is_refused(
    world, month
):
    for params, status, detail in (
        ({"project_id": world.projects["b"]}, 404, "Project not found"),
        ({"group_id": "00000000-0000-4000-8000-000000000000"}, 404, "Group not found"),
        (
            {"start": "2026-02-01", "end": "2026-01-01"},
            422,
            "The period ends before it starts",
        ),
        ({"start": "2000-01-01", "end": "2026-01-01"}, 422, "The period is too long"),
    ):
        answer = await world.call("admin_a", "GET", f"{BASE}/summary", params=params)
        assert (answer.status_code, answer.json()["detail"]) == (status, detail)
    hostile = await world.call(
        "admin_a", "GET", f"{BASE}/summary", params={"model": "a b;"}
    )
    assert hostile.status_code == 422


async def test_per_day_per_provider(world, month):
    days = await world.ok("admin_a", "GET", f"{BASE}/daily")
    two_days_ago = (month["now"] - timedelta(days=2)).date().isoformat()
    assert {
        "day": two_days_ago,
        "provider": "openai",
        "tokens": 300,
        "cost_usd": 0.5,
    } in days
    assert sum(d["tokens"] for d in days) == 1910
    assert days == sorted(days, key=lambda d: (d["day"], d["provider"]))


async def test_per_person_with_every_member_and_the_erased_ones(world, month):
    rows = await world.ok("admin_a", "GET", f"{BASE}/people")
    first = rows[0]
    assert first["user_id"] == world.users["contributor_a"]
    assert first["runs"] == 3 and first["tokens"] == 1800 and first["cost_usd"] == 2.5
    assert first["providers"] == ["anthropic", "openai"]
    assert first["models"] == ["claude-x", "gpt-y"]
    assert first["last_seen_at"].startswith(month["now"].date().isoformat())
    by_id = {r["user_id"]: r for r in rows}
    assert by_id[world.users["admin_a"]]["tokens"] == 0  # a member without activity
    assert by_id[None]["name"] is None and by_id[None]["tokens"] == 10
    assert world.users["member_b"] not in by_id
    grouped = await world.ok(
        "admin_a", "GET", f"{BASE}/people", params={"group_id": world.group}
    )
    assert [r["user_id"] for r in grouped] == [world.users["grouped_a"]]


async def test_one_person_s_timeline_and_pages(world, month):
    who = world.users["contributor_a"]
    sheet = await world.ok("admin_a", "GET", f"{BASE}/people/{who}")
    assert sheet["user"]["user_id"] == who and sheet["user"]["email"]
    assert sheet["summary"]["runs"]["total"] == 3
    kinds = [(e["kind"], e["what"]) for e in sheet["timeline"]]
    assert ("sign_in", "auth.login.local") in kinds and (
        "audit",
        "spec.claimed",
    ) in kinds
    assert ("run", "merge") in kinds
    assert all("payload" not in e for e in sheet["timeline"])
    times = [e["at"] for e in sheet["timeline"]]
    assert times == sorted(times, reverse=True)
    assert sheet["pages"]["pages"] == [
        {"client": "desktop", "page": "kanban", "opens": 3, "people": 1}
    ]
    viewer = await world.ok(
        "admin_a", "GET", f"{BASE}/people/{world.users['viewer_a']}"
    )
    assert [e["kind"] for e in viewer["timeline"]] == ["job"]
    for missing in (world.users["member_b"], "00000000-0000-4000-8000-000000000000"):
        answer = await world.call("admin_a", "GET", f"{BASE}/people/{missing}")
        assert (answer.status_code, answer.json()["detail"]) == (
            404,
            "Person not found",
        )


async def test_a_former_member_is_still_found_by_their_presence(world, month):
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember

    async with get_session_factory()() as db:
        member = await db.scalar(
            select(OrgMember).where(
                OrgMember.org_id == world.orgs["a"],
                OrgMember.user_id == world.users["contributor_a"],
            )
        )
        await db.delete(member)
        await db.commit()
    sheet = await world.ok(
        "admin_a", "GET", f"{BASE}/people/{world.users['contributor_a']}"
    )
    assert sheet["summary"]["runs"]["total"] == 3


async def test_providers_models_and_phases(world, month):
    report = await world.ok("admin_a", "GET", f"{BASE}/models")
    claude = next(m for m in report["models"] if m["model"] == "claude-x")
    assert claude["provider"] == "anthropic"
    assert claude["sessions"] == 3 and claude["runs"] == 1
    assert claude["succeeded"] == 1 and claude["success_rate"] == 1.0
    assert claude["cost_per_run_usd"] == pytest.approx(2.100001)
    qa = next(p for p in report["phases"] if p["phase"] == "qa")
    assert (qa["model"], qa["runs"], qa["failed"], qa["success_rate"]) == (
        "gpt-y",
        1,
        1,
        0.0,
    )
    roadmap = next(p for p in report["phases"] if p["phase"] == "roadmap")
    assert roadmap["runs"] == 0 and roadmap["cost_per_run_usd"] is None


async def test_per_project_and_phase(world, month):
    rows = await world.ok("admin_a", "GET", f"{BASE}/projects")
    project = next(r for r in rows if r["project_id"] == world.projects["a"])
    assert project["runs"] == 4 and project["tokens"] == 1900
    assert [p["phase"] for p in project["phases"]] == ["coding", "qa", "roadmap"]
    unassigned = next(r for r in rows if r["project_id"] is None)
    assert unassigned["name"] is None and unassigned["runs"] == 0


async def test_pages_opened_per_app(world, month):
    report = await world.ok("admin_a", "GET", f"{BASE}/pages")
    assert report["enabled"] is False
    assert report["pages"] == [
        {"client": "desktop", "page": "kanban", "opens": 4, "people": 2}
    ]


async def test_funnel_delivery_and_failure_causes(world, month):
    report = await world.ok("admin_a", "GET", f"{BASE}/delivery")
    assert report["funnel"] == {
        "invited": 1,
        "accepted": 1,
        "first_sign_in": 1,
        "first_task": 1,
        "first_merge": 1,
    }
    delivered = report["delivered"]
    assert delivered["tasks"] == 1 and delivered["cost_usd"] == 2.5
    assert delivered["cost_per_task_usd"] == 2.5
    assert 47 < delivered["median_hours_to_merge"] < 49
    assert report["failures"] == [
        {"cause": "tests", "runs": 1, "jobs": 0},
        {"cause": "timeout", "runs": 0, "jobs": 1},
        {"cause": "usage_limit", "runs": 1, "jobs": 0},
    ]
    nothing = await world.ok(
        "admin_a",
        "GET",
        f"{BASE}/delivery",
        params={"start": "2020-01-01", "end": "2020-01-02"},
    )
    assert nothing["delivered"] == {
        "tasks": 0,
        "cost_usd": 0.0,
        "cost_per_task_usd": None,
        "median_hours_to_merge": None,
    }


async def test_who_is_here_what_runs_and_who_lies_dormant(world, month):
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, ProjectJob

    # The first request opens the database, settling the runs a stopped
    # server left running: these two start after it.
    await world.ok("admin_a", "GET", f"{BASE}/presence")
    async with get_session_factory()() as db:
        db.add(
            AgentRun(
                spec_id=month["spec"],
                phase="coding",
                status="running",
                started_by=world.users["contributor_a"],
            )
        )
        db.add(
            ProjectJob(
                project_id=world.projects["a"],
                feature="ideation",
                status="running",
                started_by=None,
            )
        )
        await db.commit()
    now = await world.ok("admin_a", "GET", f"{BASE}/presence")
    assert [p["user_id"] for p in now["online"]] == [world.users["contributor_a"]]
    assert sorted((r["kind"], r["what"]) for r in now["running"]) == [
        ("job", "ideation"),
        ("run", "coding"),
    ]
    job = next(r for r in now["running"] if r["kind"] == "job")
    assert job["name"] is None and job["project"]
    dormant = {d["user_id"]: d for d in now["dormant"]}
    assert set(dormant) == {world.users["viewer_a"], world.users["analyst_a"]}
    assert dormant[world.users["analyst_a"]]["last_seen_at"] is None
    assert dormant[world.users["viewer_a"]]["email"]
    assert now["dormant_after_days"] == 30


async def test_a_table_exports_as_csv_and_is_audited(world, month):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    answer = await world.call(
        "admin_a", "GET", f"{BASE}/export", params={"view": "people"}
    )
    assert answer.status_code == 200
    assert answer.headers["content-type"].startswith("text/csv")
    assert "workpilot-usage-people-" in answer.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(answer.text)))
    assert rows[0][:3] == ["name", "email", "runs"]
    names = [r[0] for r in rows[1:]]
    assert '\'=HYPERLINK("http://x")' in names  # never read as a formula
    assert "" in names  # the erased account's row
    contributor = next(r for r in rows if r[2] == "3")
    assert contributor[6] == "anthropic openai"
    for view in ("daily", "models", "phases", "projects", "pages", "failures"):
        table = await world.call(
            "admin_a", "GET", f"{BASE}/export", params={"view": view}
        )
        assert table.status_code == 200 and len(table.text.splitlines()) >= 2, view
    refused = await world.call(
        "admin_a", "GET", f"{BASE}/export", params={"view": "secrets"}
    )
    assert refused.status_code == 422
    async with get_session_factory()() as db:
        entries = (
            await db.scalars(
                select(AuditLog).where(AuditLog.action == "usage.exported")
            )
        ).all()
    assert len(entries) == 7
    assert entries[0].org_id == world.orgs["a"]
    assert entries[0].user_id == world.users["admin_a"]
    assert entries[0].payload["view"] == "people" and entries[0].payload["rows"] >= 3


async def test_the_platform_sees_every_organization(world, month):
    figures = await world.ok("platform", "GET", f"{PLATFORM}/summary")
    assert figures["tokens"]["total"] == 1910 + 9999
    assert figures["budget"] is None
    people = await world.ok("platform", "GET", f"{PLATFORM}/people")
    assert world.users["member_b"] in {r["user_id"] for r in people}
    pages = await world.ok("platform", "GET", f"{PLATFORM}/pages")
    assert pages["enabled"] is None and len(pages["pages"]) == 2
    sheet = await world.ok(
        "platform", "GET", f"{PLATFORM}/people/{world.users['member_b']}"
    )
    assert sheet["summary"]["tokens"]["total"] == 9999
    present = await world.ok("platform", "GET", f"{PLATFORM}/presence")
    assert {p["user_id"] for p in present["online"]} == {
        world.users["contributor_a"],
        world.users["member_b"],
    }
    funnel = (await world.ok("platform", "GET", f"{PLATFORM}/delivery"))["funnel"]
    assert funnel["invited"] == 1
    refused = await world.call("admin_a", "GET", f"{PLATFORM}/summary")
    assert refused.status_code == 403


async def test_only_usage_read_opens_the_views(world, month):
    for who in ("viewer_a", "analyst_a", "contributor_a"):
        answer = await world.call(who, "GET", f"{BASE}/summary")
        assert (answer.status_code, answer.json()["detail"]) == (
            403,
            "Missing permission: usage.read",
        ), who
    assert (await world.call("owner_a", "GET", f"{BASE}/summary")).status_code == 200


def test_a_day_is_the_utc_day_in_each_database():
    from server.db.models import UsageRecord
    from sqlalchemy.dialects import postgresql, sqlite

    pg = usage_report.day_of(UsageRecord.created_at, "postgresql")
    assert "to_char(timezone(" in str(pg.compile(dialect=postgresql.dialect()))
    lite = usage_report.day_of(UsageRecord.created_at, "sqlite")
    assert "date(" in str(lite.compile(dialect=sqlite.dialect()))


@pytest.mark.parametrize(
    ("error", "cause"),
    [
        ("429 Too Many Requests", "usage_limit"),
        ("You've hit your usage limit", "usage_limit"),
        ("OAuth token has expired", "provider_sign_in"),
        ("401 Unauthorized", "provider_sign_in"),
        ("Command timed out after 600s", "timeout"),
        ("QA rejected the build", "tests"),
        ("segfault", "other"),
        (None, "other"),
    ],
)
def test_a_failure_s_cause_comes_from_a_closed_list(error, cause):
    assert usage_delivery.cause_of(error) == cause


async def test_nobody_in_the_period_gives_empty_tables(world, month):
    params = {"start": "2020-01-01", "end": "2020-01-31"}
    assert await world.ok("platform", "GET", f"{PLATFORM}/people", params=params) == []
    assert await world.ok("platform", "GET", f"{PLATFORM}/daily", params=params) == []
