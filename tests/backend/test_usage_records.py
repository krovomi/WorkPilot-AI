"""The tokens a server run uses reach the server, against the run and the
person who started it, and the monthly token budget counts them.

Before: nothing on the server counted a token. ``tokens_used_this_month``
always answered 0, so the quota's monthly budget never stopped a run, and
``agent_runs.provider`` was never filled.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import textwrap
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

POSIX = os.name == "posix"
_VALID_SECRET = "x" * 48

GOOD = {
    "phase": "coding",
    "agent_type": "coder",
    "provider": "Anthropic",
    "model": "claude-sonnet-4-6",
    "input_tokens": 1200,
    "output_tokens": 300,
    "cache_write_tokens": 50,
    "cache_read_tokens": 4000,
    "cost_usd": 0.0123,
    "estimated": False,
}


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "usage.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _fresh_db():
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    return db_engine.get_session_factory()


async def _project(factory, slug: str = "default", user: str = "u1"):
    from server.db.models import Organization, Project, SpecIndex, User
    from sqlalchemy import select

    async with factory() as db:
        if await db.get(User, user) is None:
            db.add(User(id=user, email=f"{user}@test.invalid", display_name=user))
        org_id = await db.scalar(
            select(Organization.id).where(Organization.slug == slug)
        )
        if org_id is None:
            org = Organization(name=slug, slug=slug)
            db.add(org)
            await db.flush()
            org_id = org.id
        project = Project(
            org_id=org_id, name="P", repo_url="https://x/p.git", server_path="/tmp/p"
        )
        db.add(project)
        await db.flush()
        spec = SpecIndex(project_id=project.id, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        await db.refresh(spec)
        return org_id, project.id, spec


def _line(**changes) -> bytes:
    return json.dumps({**GOOD, **changes}).encode("utf-8")


# ---------------------------------------------------------------------------
# What a line may say
# ---------------------------------------------------------------------------


def test_a_good_line_is_read_whole():
    from server.services.usage_records import parse_line

    line = parse_line(_line())
    assert line is not None
    assert line.provider == "anthropic"
    assert line.model == "claude-sonnet-4-6"
    assert line.total_tokens == 1200 + 300 + 50 + 4000
    assert line.cost_micro_usd == 12300
    assert line.estimated is False


@pytest.mark.parametrize(
    "raw",
    [
        b"not json",
        b"[1, 2]",
        b"\xff\xfe",
        _line(phase="../../etc"),
        _line(phase=""),
        _line(phase=None),
        _line(agent_type="Coder With Spaces"),
        _line(provider="a" * 41),
        _line(model="gpt 4; rm -rf /"),
        _line(model="m" * 121),
        _line(input_tokens=-1),
        _line(output_tokens=True),
        _line(cache_read_tokens=3_000_000_000),
        _line(cache_write_tokens="12"),
        _line(cost_usd=-0.5),
        _line(cost_usd=1e9),
        _line(cost_usd=float("nan")),
        _line(cost_usd="free"),
        _line(estimated="yes"),
        b'{"phase": "coding", "pad": "' + b"x" * 5000 + b'"}',
    ],
)
def test_a_line_that_does_not_fit_is_refused_whole(raw):
    from server.services.usage_records import parse_line

    assert parse_line(raw) is None


def test_both_sides_name_the_same_variable():
    from foundation import usage_channel
    from server.services import run_env, usage_records

    assert usage_channel.USAGE_FD_ENV == usage_records.USAGE_FD_ENV
    assert usage_channel.MAX_LINE_BYTES == usage_records.MAX_LINE_BYTES
    # A value the server's own environment had never reaches a run.
    assert usage_records.USAGE_FD_ENV in run_env.RUN_ENV


# ---------------------------------------------------------------------------
# The run's side
# ---------------------------------------------------------------------------


def test_outside_a_server_run_nothing_is_reported(monkeypatch):
    from foundation import usage_channel

    monkeypatch.delenv(usage_channel.USAGE_FD_ENV, raising=False)
    assert usage_channel.report(GOOD) is False
    monkeypatch.setenv(usage_channel.USAGE_FD_ENV, "not-a-number")
    assert usage_channel.report(GOOD) is False
    assert usage_channel.claim() is None


def test_a_closed_descriptor_is_no_channel(monkeypatch):
    from foundation import usage_channel

    read, write = os.pipe()
    os.close(read)
    os.close(write)
    monkeypatch.setenv(usage_channel.USAGE_FD_ENV, str(write))
    assert usage_channel.report(GOOD) is False


@pytest.mark.skipif(not POSIX, reason="a pipe descriptor handed to a run is POSIX")
def test_the_run_writes_one_line_per_session(monkeypatch):
    from foundation import usage_channel

    read, write = os.pipe()
    try:
        monkeypatch.setenv(usage_channel.USAGE_FD_ENV, str(write))
        assert usage_channel.report(GOOD) is True
        assert usage_channel.report({"phase": "x" * 5000}) is False
        assert usage_channel.report({"phase": object()}) is False
        os.close(write)
        write = -1
        data = os.read(read, 65536)
    finally:
        os.close(read)
        if write != -1:
            os.close(write)
    assert data.count(b"\n") == 1
    assert json.loads(data) == GOOD


def test_a_session_reports_through_the_usage_tracker(monkeypatch, tmp_path):
    """``record_session_usage`` is what every provider's session calls."""
    from core import usage_tracker

    sent: list[dict] = []
    monkeypatch.setattr(usage_tracker, "report_to_server", sent.append)
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)
    usage_tracker.record_session_usage(
        spec_dir=spec_dir,
        project_dir=tmp_path,
        phase="qa_review",
        agent_type="qa_reviewer",
        model="gpt-5",
        provider="openai",
        input_tokens=10,
        output_tokens=5,
        cost_usd=0.001,
        cache_creation_input_tokens=2,
        cache_read_input_tokens=3,
        usage_source="estimated",
    )
    assert sent == [
        {
            "phase": "qa_review",
            "agent_type": "qa_reviewer",
            "provider": "openai",
            "model": "gpt-5",
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_write_tokens": 2,
            "cache_read_tokens": 3,
            "cost_usd": 0.001,
            "estimated": True,
        }
    ]


@pytest.mark.skipif(not POSIX, reason="a pipe descriptor handed to a run is POSIX")
def test_the_agents_commands_never_receive_the_descriptor(tmp_path):
    """The run claims the descriptor: a command it starts, even one asking
    to keep every descriptor, cannot write on it."""
    read, write = os.pipe()
    child = textwrap.dedent(
        """
        import os, subprocess, sys
        from foundation import usage_channel  # claims it on import
        fd = os.environ["WORKPILOT_USAGE_FD"]
        probe = "import os, sys; os.fstat(int(sys.argv[1]))"
        code = subprocess.call(
            [sys.executable, "-c", probe, fd], close_fds=False
        )
        sys.exit(0 if code != 0 else 3)
        """
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", child],
            cwd=str(_BACKEND),
            env={**os.environ, "WORKPILOT_USAGE_FD": str(write)},
            pass_fds=(write,),
            capture_output=True,
            timeout=60,
        )
    finally:
        os.close(read)
        os.close(write)
    assert proc.returncode == 0, proc.stderr.decode(errors="replace")


# ---------------------------------------------------------------------------
# The server's side
# ---------------------------------------------------------------------------

_CHILD = textwrap.dedent(
    """
    import json, os
    from foundation.usage_channel import report
    line = json.loads(os.environ["USAGE_TEST_LINE"])
    assert report(line)
    os.write(int(os.environ["WORKPILOT_USAGE_FD"]), b"not json\\n")
    line["phase"] = "qa_review"
    line["provider"] = "openai"
    assert report(line)
    """
)


@pytest.mark.skipif(not POSIX, reason="a pipe descriptor handed to a run is POSIX")
@pytest.mark.asyncio
async def test_a_run_s_sessions_are_stored_against_it(monkeypatch, tmp_path):
    from server.db.models import AgentRun, UsageRecord
    from server.services import quotas
    from server.services import run_manager as rm
    from sqlalchemy import select

    factory = await _fresh_db()
    org_id, project_id, spec = await _project(factory)
    manager = rm.RunManager()

    async def _env(*_a):
        return {"USAGE_TEST_LINE": json.dumps(GOOD)}

    async def _notify(*_a):
        return None

    monkeypatch.setattr(manager, "_build_env", _env)
    monkeypatch.setattr(manager, "_notify", _notify)
    monkeypatch.setattr(rm, "build_command", lambda *_a: [sys.executable, "-c", _CHILD])
    monkeypatch.setattr(rm, "confine", lambda cmd, *_a: cmd)

    run = await manager.start_run(spec, project_id, str(tmp_path), "build", "u1")
    for _ in range(1000):
        if not manager.is_running(spec.id):
            break
        await asyncio.sleep(0.01)
    assert not manager.is_running(spec.id), "the run never ended"

    async with factory() as db:
        stored = list(await db.scalars(select(UsageRecord).order_by(UsageRecord.phase)))
        finished = await db.get(AgentRun, run.id)
        used = await quotas.tokens_used_this_month(db, org_id)
    assert finished is not None and finished.status == "succeeded", finished.error
    assert [r.phase for r in stored] == ["coding", "qa_review"]
    assert {r.run_id for r in stored} == {run.id}
    assert {r.user_id for r in stored} == {"u1"}
    assert {r.org_id for r in stored} == {org_id}
    assert {r.project_id for r in stored} == {project_id}
    assert stored[0].provider == "anthropic" and stored[1].provider == "openai"
    # The run takes the provider of its first session.
    assert finished.provider == "anthropic"
    assert used == 2 * (1200 + 300 + 50 + 4000)


@pytest.mark.asyncio
async def test_the_monthly_budget_counts_this_month_of_this_organization_only():
    from fastapi import HTTPException
    from server.db.models import OrgQuota, UsageRecord
    from server.services import quotas

    factory = await _fresh_db()
    org_id, project_id, _ = await _project(factory)
    other_org, other_project, _ = await _project(factory, slug="other", user="u2")
    now = datetime.now(UTC)
    last_month = now.replace(day=1) - timedelta(days=2)

    def record(org, project, tokens, when):
        return UsageRecord(
            org_id=org,
            project_id=project,
            user_id="u1",
            phase="coding",
            input_tokens=tokens,
            created_at=when,
        )

    async with factory() as db:
        db.add_all(
            [
                record(org_id, project_id, 700, now),
                record(org_id, project_id, 400, now),
                record(org_id, project_id, 9_000, last_month),
                record(other_org, other_project, 5_000, now),
            ]
        )
        db.add(
            OrgQuota(org_id=org_id, monthly_token_budget=1_000, enforce_hard_stop=True)
        )
        await db.commit()

    async with factory() as db:
        assert await quotas.tokens_used_this_month(db, org_id) == 1_100
        assert await quotas.tokens_used_this_month(db, other_org) == 5_000
        snapshot = await quotas.quota_snapshot(db, org_id)
        assert snapshot["used_tokens_this_month"] == 1_100
        with pytest.raises(HTTPException) as refused:
            await quotas.enforce_run_quota(db, org_id)
        assert refused.value.status_code == 402
        # Below its budget, the other organization still runs.
        db.add(
            OrgQuota(
                org_id=other_org, monthly_token_budget=6_000, enforce_hard_stop=True
            )
        )
        await db.commit()
        await quotas.enforce_run_quota(db, other_org)


@pytest.mark.asyncio
async def test_a_deleted_account_keeps_the_totals_without_its_name():
    from server.db.models import UsageRecord, User
    from server.services import quotas

    factory = await _fresh_db()
    org_id, project_id, _ = await _project(factory, user="gone")
    async with factory() as db:
        db.add(
            UsageRecord(
                org_id=org_id,
                project_id=project_id,
                user_id="gone",
                phase="coding",
                output_tokens=42,
            )
        )
        await db.commit()
    async with factory() as db:
        await db.delete(await db.get(User, "gone"))
        await db.commit()
    async with factory() as db:
        assert await quotas.tokens_used_this_month(db, org_id) == 42
        (row,) = (await db.execute(UsageRecord.__table__.select())).all()
        assert row.user_id is None


@pytest.mark.asyncio
async def test_a_line_past_the_limit_is_skipped_and_the_next_is_kept():
    from server.db.models import UsageRecord
    from server.services.usage_records import UsageChannel, UsageOwner
    from sqlalchemy import func, select

    if not POSIX:
        pytest.skip("a pipe descriptor handed to a run is POSIX")
    factory = await _fresh_db()
    org_id, project_id, _ = await _project(factory)
    channel = UsageChannel(UsageOwner(org_id, project_id, "u1"))
    write = channel.pass_fds[0]
    task = asyncio.create_task(channel.collect())
    os.write(write, b"y" * 9000 + b"\n")
    os.write(write, _line() + b"\n")
    channel.started()
    assert await task == 1
    async with factory() as db:
        assert await db.scalar(select(func.count(UsageRecord.id))) == 1


def test_a_run_of_a_deleted_project_gets_no_channel():
    from server.services.usage_records import UsageChannel

    channel = UsageChannel(None)
    assert channel.env == {} and channel.pass_fds == ()
    assert asyncio.run(channel.collect()) == 0
    channel.close()
