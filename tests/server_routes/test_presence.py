"""Who used the server and when: sign-ins refused, presence days, jobs, retention.

A refused sign-in enters the organization's history (``auth.login_failed``)
with its method and reason, never the password or an unknown address; each
authenticated request notes the day (``presence_days``), at most every few
minutes; a job started is audited; usage data past its retention is erased.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from server.auth.oidc import OidcError
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from tests.server_routes.world import World


async def presence_rows(world: World, who: str) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import PresenceDay

    async with get_session_factory()() as db:
        return list(
            await db.scalars(
                select(PresenceDay)
                .where(PresenceDay.user_id == world.users[who])
                .order_by(PresenceDay.day)
            )
        )


async def refusals(world: World) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    async with get_session_factory()() as db:
        return list(
            await db.scalars(
                select(AuditLog).where(AuditLog.action == "auth.login_failed")
            )
        )


class TestRefusedSignIns:
    async def test_a_wrong_password_is_audited_in_the_account_s_organization(
        self, world
    ):
        await world.give_password("contributor_a")
        answer = await world.client.post(
            "/auth/login",
            json={"email": "contributor_a@example.com", "password": "not-it-at-all"},
        )
        assert answer.status_code == 401
        [row] = await refusals(world)
        assert row.user_id == world.users["contributor_a"]
        assert row.org_id == world.orgs["a"]
        assert row.payload == {"method": "local", "reason": "bad_password"}
        assert row.login_method == "local"
        assert "not-it-at-all" not in str(row.payload)
        # The organization's administrators read it in its history.
        history = await world.ok(
            "admin_a", "GET", "/admin/audit", params={"action": "auth.login_failed"}
        )
        assert [e["action"] for e in history] == ["auth.login_failed"]

    async def test_an_unknown_address_is_audited_without_it(self, world):
        answer = await world.client.post(
            "/auth/login",
            json={"email": "ghost@example.com", "password": "whatever-it-is"},
        )
        assert answer.status_code == 401
        [row] = await refusals(world)
        assert row.user_id is None and row.org_id is None
        assert row.payload == {"method": "local", "reason": "unknown_account"}
        assert "ghost" not in str(row.payload)

    async def test_a_disabled_account_is_named_as_such(self, world):
        from server.db.engine import get_session_factory
        from server.db.models import User

        password = await world.give_password("member_b")
        async with get_session_factory()() as db:
            user = await db.get(User, world.users["member_b"])
            user.is_active = False
            await db.commit()
        answer = await world.client.post(
            "/auth/login",
            json={"email": "member_b@example.com", "password": password},
        )
        assert answer.status_code == 401
        [row] = await refusals(world)
        assert row.org_id == world.orgs["b"]
        assert row.payload["reason"] == "disabled"

    async def test_an_account_in_no_organization_is_audited_outside_any(self, world):
        await world.give_password("platform")
        await world.client.post(
            "/auth/login",
            json={"email": "platform@example.com", "password": "wrong-password-1"},
        )
        [row] = await refusals(world)
        assert row.user_id == world.users["platform"] and row.org_id is None

    async def test_an_identity_provider_token_refused_is_audited(
        self, world, monkeypatch
    ):
        from server.auth import oidc_generic

        entra = await world.client.post(
            "/auth/oidc/exchange", json={"id_token": "header.payload.signature"}
        )
        assert entra.status_code == 401

        async def refuse(token):
            raise OidcError("The identity provider has no usable discovery document")

        monkeypatch.setattr(oidc_generic, "avalidate_id_token", refuse)
        sso = await world.client.post(
            "/auth/sso/exchange", json={"id_token": "header.payload.signature"}
        )
        assert sso.status_code == 401
        rows = await refusals(world)
        assert sorted((r.login_method, r.payload["reason"]) for r in rows) == [
            ("entra", "provider_refused"),
            ("oidc", "provider_refused"),
        ]
        assert all(r.user_id is None for r in rows)


class TestPresence:
    async def test_a_request_notes_the_day_once_per_refresh(self, world):
        from server.services import presence

        await world.ok("contributor_a", "GET", "/projects")
        [row] = await presence_rows(world, "contributor_a")
        assert row.org_id == world.orgs["a"] and row.day == datetime.now(UTC).date()
        first = row.last_seen_at
        # A second request within the refresh window writes nothing.
        await world.ok("contributor_a", "GET", "/projects")
        [again] = await presence_rows(world, "contributor_a")
        assert again.last_seen_at == first
        # Past it, the same day's row moves; it is not duplicated. On a fixed
        # noon: from the clock, a run near midnight would cross into a new day.
        uid, org = world.users["contributor_a"], world.orgs["a"]
        noon = datetime(2026, 1, 15, 12, 0, tzinfo=UTC)
        later = noon + presence.REFRESH
        assert await presence.touch(uid, org, noon)
        assert await presence.touch(uid, org, later)
        [moved] = [
            r
            for r in await presence_rows(world, "contributor_a")
            if r.day == noon.date()
        ]
        assert moved.last_seen_at.replace(tzinfo=UTC) == later

    async def test_a_new_day_adds_a_row_and_no_organization_is_one_too(self, world):
        from server.services import presence

        uid = world.users["platform"]
        today = datetime(2026, 11, 20, 23, 58, tzinfo=UTC)
        assert await presence.touch(uid, None, today)
        assert await presence.touch(uid, None, today + timedelta(minutes=3))
        assert not await presence.touch(uid, None, today + timedelta(minutes=4))
        rows = await presence_rows(world, "platform")
        assert [(r.day, r.org_id) for r in rows] == [
            (date(2026, 11, 20), None),
            (date(2026, 11, 21), None),
        ]

    async def test_a_personal_token_on_the_mcp_endpoint_counts(self, world):
        made = await world.call(
            "contributor_a",
            "POST",
            "/users/me/access-tokens",
            json={"name": "Claude Desktop", "scope": "read"},
        )
        assert made.status_code == 201, made.text
        from server.services import presence

        presence.forget()
        answer = await world.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"Authorization": f"Bearer {made.json()['token']}"},
        )
        assert answer.status_code == 200
        assert len(await presence_rows(world, "contributor_a")) == 1

    async def test_a_failed_write_lets_the_request_through_and_retries(
        self, world, monkeypatch, caplog
    ):
        from server.services import presence

        async def down(*args):
            raise OperationalError("UPDATE presence_days", {}, Exception("locked"))

        monkeypatch.setattr(presence, "_write", down)
        await world.ok("viewer_a", "GET", "/projects")
        assert "Presence not recorded: OperationalError" in caplog.text
        assert "viewer_a" not in caplog.text
        # Not remembered as written: the next request tries again.
        assert presence._due(
            (world.users["viewer_a"], world.orgs["a"]), datetime.now(UTC)
        )

    async def test_the_throttle_forgets_everyone_past_its_bound(
        self, world, monkeypatch
    ):
        from server.services import presence

        monkeypatch.setattr(presence, "MAX_REMEMBERED", 1)
        uid = world.users["viewer_a"]
        assert await presence.touch(uid, "org-x")
        assert await presence.touch(uid, world.orgs["a"])
        assert list(presence._written) == [(uid, world.orgs["a"])]


async def test_the_racing_insert_is_rolled_back_quietly(world, monkeypatch):
    """The select saw nothing, the insert met the other request's row."""
    from server.services import presence

    uid = world.users["viewer_a"]
    now = datetime(2026, 11, 21, 9, 0, tzinfo=UTC)
    await presence._write(uid, world.orgs["a"], now.date(), now)

    class Blind:
        def __init__(self, inner):
            self.inner = inner

        async def __aenter__(self):
            db = await self.inner.__aenter__()

            async def nothing(*args, **kwargs):
                return None

            db.scalar = nothing
            return db

        async def __aexit__(self, *exc):
            return await self.inner.__aexit__(*exc)

    real = presence.get_session_factory
    monkeypatch.setattr(
        presence, "get_session_factory", lambda: lambda: Blind(real()())
    )
    await presence._write(uid, world.orgs["a"], now.date(), now)
    assert len(await presence_rows(world, "viewer_a")) == 1


async def test_a_started_job_is_audited(world, monkeypatch):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from server.services import project_jobs

    jobs = project_jobs.ProjectJobs()

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(jobs, "_execute", nothing)
    job = await jobs.start(
        project_id=world.projects["a"],
        org_id=world.orgs["a"],
        server_path=str(world.clone("a")),
        feature="roadmap",
        runner="roadmap_runner.py",
        args=[],
        user_id=world.users["contributor_a"],
    )
    async with get_session_factory()() as db:
        [row] = await db.scalars(
            select(AuditLog).where(AuditLog.action == project_jobs.JOB_STARTED)
        )
    assert row.user_id == world.users["contributor_a"]
    assert row.org_id == world.orgs["a"]
    assert row.project_id == world.projects["a"]
    assert row.payload == {"feature": "roadmap", "job_id": job.id}


class TestRetention:
    async def test_the_sweep_erases_what_is_past_the_retention(
        self, world, monkeypatch
    ):
        from server import config as server_config
        from server.db.engine import get_session_factory
        from server.db.models import PresenceDay, UsageRecord
        from server.services import usage_retention

        monkeypatch.setenv("WORKPILOT_USAGE_RETENTION_DAYS", "40")
        server_config.reset_settings_cache()
        now = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
        uid = world.users["viewer_a"]
        async with get_session_factory()() as db:
            for age in (10, 50):
                at = now - timedelta(days=age)
                db.add(
                    PresenceDay(
                        user_id=uid,
                        org_id=world.orgs["a"],
                        day=at.date(),
                        last_seen_at=at,
                    )
                )
                db.add(_usage(world, at))
            await db.commit()
        assert await usage_retention.sweep(now) == {
            "usage_records": 1,
            "presence_days": 1,
            "page_visits": 0,
        }
        async with get_session_factory()() as db:
            assert len(list(await db.scalars(select(PresenceDay)))) == 1
            assert len(list(await db.scalars(select(UsageRecord)))) == 1

    def test_the_retention_is_kept_within_its_bounds(self, monkeypatch):
        from server import config as server_config
        from server.services import usage_retention

        for value, days in (("1", 30), ("99999", 3650), ("200", 200)):
            monkeypatch.setenv("WORKPILOT_USAGE_RETENTION_DAYS", value)
            server_config.reset_settings_cache()
            assert usage_retention.retention() == timedelta(days=days)
        monkeypatch.delenv("WORKPILOT_USAGE_RETENTION_DAYS")
        server_config.reset_settings_cache()
        assert usage_retention.retention() == timedelta(days=365)

    async def test_the_periodic_sweep_runs_logs_a_failure_and_stops(
        self, monkeypatch, caplog
    ):
        import asyncio

        from server.services import usage_retention

        calls: list[str] = []

        async def ready():
            calls.append("ready")

        async def sweep(now=None):
            calls.append("sweep")
            if calls.count("sweep") == 1:
                raise OperationalError("DELETE", {}, Exception("locked"))
            return {}

        monkeypatch.setattr(usage_retention, "sweep", sweep)
        task = usage_retention.start(ready=ready, interval=0)
        assert usage_retention.start(ready=ready) is task
        while calls.count("sweep") < 2:
            await asyncio.sleep(0)
        await usage_retention.stop()
        await usage_retention.stop()
        assert task.cancelled()
        assert "Usage retention sweep failed: OperationalError" in caplog.text


def _usage(world: World, at: datetime):
    from server.db.models import UsageRecord

    return UsageRecord(
        org_id=world.orgs["a"],
        project_id=world.projects["a"],
        user_id=world.users["viewer_a"],
        phase="coding",
        created_at=at,
    )
