"""Server mode: the workspace views of a server project, read from the server.

The dashboard, the analytics, the history of sessions and the costs of a
server project are computed by the server for that project: from its cards,
the runs and jobs it started, and the ledgers its agents keep in its clone.
These tests hold them to that project, and only it: two organizations each
have a project with a card of the same name, and neither sees anything of the
other's; a ledger reached through a link, or too large, is not read; nothing
served says where a clone is.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
# A key-shaped value the redaction masks; not a real key.
_FAKE_KEY = "sk-ant-api03-" + "A" * 24  # pragma: allowlist secret

NOW = datetime.now(UTC)
RUN_START = NOW - timedelta(days=2)


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def _usage(clone: Path, spec: str, at: datetime, phase: str, tokens, cost) -> dict:
    return {
        # What usage_tracker writes: the directory the run worked in.
        "project_id": str(clone),
        "provider": "anthropic",
        "model": "sonnet",
        "input_tokens": tokens[0],
        "output_tokens": tokens[1],
        "cost": cost,
        "task_id": spec,
        "spec_id": spec,
        "agent_type": "coder",
        "phase": phase,
        "timestamp": _iso(at),
    }


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _clone(root: Path, name: str, statuses: dict[str, str | None]) -> Path:
    clone = root / name
    for spec, status in statuses.items():
        directory = clone / ".workpilot" / "specs" / spec
        directory.mkdir(parents=True)
        if status:
            _write(directory / "implementation_plan.json", {"status": status})
    return clone


@pytest.fixture
async def server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "workspace.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import (
        AgentRun,
        Organization,
        Project,
        ProjectJob,
        ProjectMember,
        SpecIndex,
        User,
    )
    from server.services import project_jobs

    monkeypatch.setattr(project_jobs, "_jobs", None)
    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()

    repos = tmp_path / "repos"
    clone_a = _clone(
        repos, "a", {"001-login": "done", "002-cart": "in_progress", "003-help": None}
    )
    clone_b = _clone(repos, "b", {"001-login": "in_progress"})
    work_a = clone_a / ".workpilot" / "worktrees" / "tasks" / "001-login" / ".workpilot"
    _write(
        work_a / "cost_data.json",
        {
            "usages": [
                _usage(
                    clone_a,
                    "001-login",
                    RUN_START + timedelta(minutes=5),
                    "coding",
                    (1000, 500),
                    0.5,
                ),
                _usage(
                    clone_a,
                    "001-login",
                    RUN_START + timedelta(hours=1, minutes=5),
                    "qa_review",
                    (200, 100),
                    0.1,
                ),
                # Before any run: counted in the totals, in no session.
                _usage(
                    clone_a,
                    "001-login",
                    RUN_START - timedelta(hours=3),
                    "planning",
                    (10, 10),
                    9.0,
                ),
            ],
            "budgets": {str(clone_a): {"limit": 1}},
        },
    )
    _write(
        work_a / "dashboard_snapshot.json",
        {
            "_qa_total": 2,
            "_qa_passed": 1,
            "_qa_score_sum": 1.5,
            "merge_auto_count": 1,
            "merge_manual_count": 0,
        },
    )
    _write(
        clone_a / ".workpilot" / "cost_data.json",
        {
            "usages": [
                _usage(clone_a, "", NOW - timedelta(hours=1), "insights", (50, 50), 0.2)
            ]
        },
    )
    _write(
        clone_b
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-login"
        / ".workpilot"
        / "cost_data.json",
        {
            "usages": [
                _usage(
                    clone_b,
                    "001-login",
                    RUN_START + timedelta(minutes=5),
                    "coding",
                    (7777, 7777),
                    100.0,
                )
            ]
        },
    )

    async with db_engine.get_session_factory()() as db:
        db.add_all(
            [
                User(id="u-ada", email="ada@a.test", display_name="Ada"),
                User(id="u-eve", email="eve@b.test", display_name="Eve"),
            ]
        )
        org_a = Organization(name="A", slug="org-a")
        org_b = Organization(name="B", slug="org-b")
        db.add_all([org_a, org_b])
        await db.flush()
        project_a = Project(
            org_id=org_a.id,
            name="Shop",
            repo_url="https://x/a.git",
            server_path=str(clone_a),
        )
        project_b = Project(
            org_id=org_b.id,
            name="Shop",
            repo_url="https://x/b.git",
            server_path=str(clone_b),
        )
        db.add_all([project_a, project_b])
        await db.flush()
        db.add_all(
            [
                ProjectMember(project_id=project_a.id, user_id="u-ada", role="viewer"),
                ProjectMember(project_id=project_b.id, user_id="u-eve", role="owner"),
            ]
        )
        spec_a = SpecIndex(
            project_id=project_a.id, spec_name="001-login", status="done"
        )
        spec_b = SpecIndex(
            project_id=project_b.id, spec_name="001-login", status="in_progress"
        )
        db.add_all([spec_a, spec_b])
        await db.flush()
        runs = [
            AgentRun(
                spec_id=spec_a.id,
                phase="build",
                started_by="u-ada",
                model="sonnet",
                status="succeeded",
                started_at=RUN_START,
                finished_at=RUN_START + timedelta(minutes=30),
            ),
            AgentRun(
                spec_id=spec_a.id,
                phase="qa",
                started_by="u-ada",
                status="failed",
                started_at=RUN_START + timedelta(hours=1),
                finished_at=RUN_START + timedelta(hours=1, minutes=10),
                error=f"QA failed with {_FAKE_KEY}",
            ),
            AgentRun(
                spec_id=spec_b.id,
                phase="build",
                started_by="u-eve",
                status="failed",
                started_at=RUN_START,
                finished_at=RUN_START + timedelta(minutes=30),
                error="org B only",
            ),
        ]
        jobs = [
            ProjectJob(
                project_id=project_a.id,
                feature="roadmap",
                started_by="u-ada",
                status="succeeded",
                started_at=NOW - timedelta(hours=2),
                finished_at=NOW - timedelta(hours=1),
            ),
            ProjectJob(
                project_id=project_b.id,
                feature="ideation",
                started_by="u-eve",
                status="succeeded",
                started_at=NOW - timedelta(hours=2),
                finished_at=NOW - timedelta(hours=1),
            ),
        ]
        db.add_all(runs + jobs)
        await db.commit()
        ids = {
            "a": project_a.id,
            "b": project_b.id,
            "org_a": org_a.id,
            "org_b": org_b.id,
            "run_b": runs[2].id,
            "job_b": jobs[1].id,
        }
    yield {"ids": ids, "clone_a": clone_a, "clone_b": clone_b}
    server_config.reset_settings_cache()


async def _scope(server, user: str, org: str, project: str):
    """The scope the route's dependency resolves, for this person acting in `org`."""
    from server.authz.principal import Principal
    from server.authz.scope import load_project_scope
    from server.db.engine import get_session_factory

    principal = Principal(id=user, email=f"{user}@x.test", org_id=server["ids"][org])
    async with get_session_factory()() as db:
        return await load_project_scope(db, principal, server["ids"][project])


async def _call(route, scope, **kwargs):
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        if "db" in route.__code__.co_varnames:
            kwargs["db"] = db
        return await route(scope=scope, **kwargs)


@pytest.mark.asyncio
async def test_another_tenant_s_project_is_not_found(server):
    with pytest.raises(HTTPException) as across:
        await _scope(server, "u-eve", "org_b", "a")
    assert across.value.status_code == 404
    with pytest.raises(HTTPException) as back:
        await _scope(server, "u-ada", "org_a", "b")
    assert back.value.status_code == 404
    # A viewer reads the workspace of their project.
    scope = await _scope(server, "u-ada", "org_a", "a")
    assert scope.project_role == "viewer"


@pytest.mark.asyncio
async def test_sessions_are_the_project_s_runs_and_jobs_with_their_spend(server):
    from shared_features.workspace import sessions

    scope = await _scope(server, "u-ada", "org_a", "a")
    answer = await _call(sessions, scope, limit=200)
    entries = answer["sessions"]
    assert [(e["kind"], e["phase"]) for e in entries] == [
        ("job", "roadmap"),
        ("run", "qa"),
        ("run", "build"),
    ]
    job, qa, build = entries
    assert build["spec"] == "001-login" and build["started_by"] == "Ada"
    assert build["status"] == "succeeded" and build["duration_seconds"] == 1800
    assert build["tokens"] == 1500 and build["cost"] == pytest.approx(0.5)
    assert build["phases"] == [{"name": "coding", "tokens": 1500, "cost": 0.5}]
    assert qa["tokens"] == 300 and qa["cost"] == pytest.approx(0.1)
    assert _FAKE_KEY not in qa["error"] and qa["error"].startswith("QA failed")
    assert job["tokens"] is None and job["spec"] is None
    served = json.dumps(answer)
    assert server["ids"]["run_b"] not in served
    assert server["ids"]["job_b"] not in served
    assert "org B only" not in served and "Eve" not in served
    assert str(server["clone_a"]) not in served


@pytest.mark.asyncio
async def test_costs_are_read_from_the_project_s_own_ledgers(server):
    from shared_features.workspace import costs

    scope = await _scope(server, "u-ada", "org_a", "a")
    answer = await _call(costs, scope)
    summary = answer["summary"]
    assert summary["total_cost"] == pytest.approx(0.5 + 0.1 + 9.0 + 0.2)
    assert summary["tokens_input"] == 1000 + 200 + 10 + 50
    assert summary["tokens_output"] == 500 + 100 + 10 + 50
    assert summary["cost_by_model"] == {"anthropic/sonnet": pytest.approx(9.8)}
    assert set(summary) == {
        "total_cost",
        "cost_by_provider",
        "cost_by_model",
        "total_tokens",
        "tokens_input",
        "tokens_output",
        "period_days",
        "daily_avg",
        "trend_pct",
    }
    assert str(server["clone_a"]) not in json.dumps(answer)

    other = await _scope(server, "u-eve", "org_b", "b")
    theirs = (await _call(costs, other))["summary"]
    assert theirs["total_cost"] == pytest.approx(100.0)


@pytest.mark.asyncio
async def test_the_dashboard_counts_the_cards_and_reads_qa_and_merges(server):
    from shared_features.workspace import dashboard

    scope = await _scope(server, "u-ada", "org_a", "a")
    snapshot = (await _call(dashboard, scope))["snapshot"]
    assert snapshot["tasks_by_status"] == {
        "completed": 1,
        "in_progress": 1,
        "pending": 1,
    }
    assert snapshot["qa_first_pass_rate"] == pytest.approx(50.0)
    assert snapshot["qa_avg_score"] == pytest.approx(0.75)
    assert snapshot["merge_auto_count"] == 1
    assert snapshot["total_tokens"] == 1500 + 300 + 20 + 100
    assert snapshot["tokens_by_provider"] == {"anthropic": 1920}

    other = await _scope(server, "u-eve", "org_b", "b")
    theirs = (await _call(dashboard, other))["snapshot"]
    assert theirs["tasks_by_status"] == {"in_progress": 1}
    assert theirs["total_cost"] == pytest.approx(100.0)


def test_a_ledger_out_of_the_clone_or_too_large_is_not_read(tmp_path):
    from shared_features import usage_ledger

    clone = tmp_path / "clone"
    elsewhere = tmp_path / "elsewhere" / ".workpilot"
    _write(
        elsewhere / "cost_data.json",
        {"usages": [_usage(clone, "001-x", NOW, "coding", (1, 1), 50.0)]},
    )
    tasks = clone / ".workpilot" / "worktrees" / "tasks"
    tasks.mkdir(parents=True)
    # A workspace that is a link out of the clone, and one whose ledger is.
    os.symlink(elsewhere.parent, tasks / "001-x", target_is_directory=True)
    (tasks / "002-y" / ".workpilot").mkdir(parents=True)
    os.symlink(
        elsewhere / "cost_data.json", tasks / "002-y" / ".workpilot" / "cost_data.json"
    )
    # Not named like a card.
    _write(
        tasks / "notes" / ".workpilot" / "cost_data.json",
        {"usages": [_usage(clone, "001-x", NOW, "coding", (1, 1), 20.0)]},
    )
    # Over its size.
    big = [_usage(clone, "003-z", NOW, "coding", (1, 1), 1.0)] * 30_000
    _write(tasks / "003-z" / ".workpilot" / "cost_data.json", {"usages": big})
    assert (tasks / "003-z" / ".workpilot" / "cost_data.json").stat().st_size > (
        usage_ledger.FILE_LIMITS["cost_data.json"]
    )
    # A malformed record is skipped, the rest read.
    _write(
        tasks / "004-w" / ".workpilot" / "cost_data.json",
        {
            "usages": [
                {"timestamp": "not a date", "cost": 3},
                {
                    "timestamp": _iso(NOW),
                    "cost": True,
                    "input_tokens": -4,
                    "output_tokens": float("inf"),
                    "provider": "p" * 500,
                },
                _usage(clone, "004-w", NOW, "coding", (2, 3), 0.25),
            ]
        },
    )
    ledgers = usage_ledger.read_ledgers(clone)
    assert [u.cost for u in ledgers.usages] == [0.0, 0.25]
    assert ledgers.usages[0].tokens == 0
    assert len(ledgers.usages[0].provider) == usage_ledger.LABEL_MAX


def test_the_workspace_is_read_with_the_analytics_permission():
    from server.authz.catalog import domain_for_feature
    from server.authz.mounting import permission_for
    from shared_features import mount_all
    from shared_features.workspace import router

    mounted: list[tuple[object, str]] = []
    mount_all(lambda r, feature: mounted.append((r, feature)))
    assert (router, "workspace") in mounted
    domain = domain_for_feature("workspace")
    assert domain == "analytics"
    paths = {(m, route.path) for route in router.routes for m in route.methods}
    assert paths == {
        ("GET", "/api/features/workspace/sessions"),
        ("GET", "/api/features/workspace/costs"),
        ("GET", "/api/features/workspace/dashboard"),
    }
    for method, path in paths:
        assert permission_for(method, path, domain) == "analytics.read"


def test_the_desktop_dashboard_routes_answer_only_in_local_mode(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    server_config.reset_settings_cache()
    from dashboard.api import router

    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        assert client.get("/api/dashboard/stats").status_code == 200
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
        monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
        server_config.reset_settings_cache()
        for path in (
            "/api/dashboard/stats",
            "/api/sessions/p-1",
            "/api/dashboard/snapshot/repos/p-1",
            "/api/dashboard/export/p-1",
        ):
            assert client.get(path).status_code == 404, path
    server_config.reset_settings_cache()
