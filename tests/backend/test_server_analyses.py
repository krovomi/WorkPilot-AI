"""Server mode: the analyses of a server project, run as jobs on its clone.

The desktop app's analysis views run a runner in the project's folder and
show the report it prints; a server project's analysis runs on the server.
These tests hold a job to a declared analysis, its runner and its closed
options, and its report to a file of the clone that every member reads.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48

_FAKE_A11Y = """
import json, sys
args = sys.argv[1:]
print("args", " ".join(args[2:]), flush=True)
print("A11Y_EVENT:" + json.dumps({"type": "progress", "data": {"status": "Scanning"}}), flush=True)
print("A11Y_RESULT:" + json.dumps({"violations": [{"rule": "alt-text"}], "level": args[-1]}), flush=True)
print("A11Y_RESULT:not json", flush=True)
"""

_FAKE_DEBT = """
import json, sys
print(json.dumps({"result": {"items": [{"id": "D1", "roi": 3.5}], "trend": [1, 2]}}), flush=True)
"""

_FAKE_FAILING = """
import sys
print("I18N_RESULT:{}", flush=True)
print("I18N_ERROR:no locales", flush=True)
sys.exit(1)
"""


@pytest.fixture
async def server(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    # Confinement is proven in test_run_isolation; here, what the job runs.
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "analyses.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User
    from server.services import project_jobs

    monkeypatch.setattr(project_jobs, "_jobs", None)
    monkeypatch.setattr(project_jobs, "emit_board_event", lambda *a: None)
    backend = tmp_path / "backend"
    runners = backend / "runners"
    runners.mkdir(parents=True)
    (runners / "accessibility_runner.py").write_text(_FAKE_A11Y, encoding="utf-8")
    (runners / "tech_debt_runner.py").write_text(_FAKE_DEBT, encoding="utf-8")
    (runners / "i18n_runner.py").write_text(_FAKE_FAILING, encoding="utf-8")
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", backend)

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clones = [tmp_path / "repos" / "shop", tmp_path / "repos" / "other"]
    for clone in clones:
        clone.mkdir(parents=True)
    async with db_engine.get_session_factory()() as db:
        db.add(User(id="u-ada", email="ada@x.test", display_name="Ada"))
        orgs = [
            Organization(name="A", slug="org-a"),
            Organization(name="B", slug="org-b"),
        ]
        db.add_all(orgs)
        await db.flush()
        projects = [
            Project(
                org_id=org.id,
                name=name,
                repo_url=f"https://github.com/acme/{name}.git",
                server_path=str(clone),
            )
            for org, name, clone in zip(orgs, ("shop", "other"), clones, strict=True)
        ]
        db.add_all(projects)
        await db.commit()
        ids = [(p.id, p.org_id) for p in projects]
    yield {"ids": ids, "clones": clones}
    server_config.reset_settings_cache()


def _scope(server, role="member", which=0):
    from server.authz.scope import ProjectScope

    project_id, org_id = server["ids"][which]
    return ProjectScope(project_id, org_id, server["clones"][which], role)


def _request(user_id="u-ada"):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(
        id=user_id, email=f"{user_id}@x.test", permissions=frozenset({"agent.execute"})
    )
    return request


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _wait_final(job_id: str):
    from server.db.models import ProjectJob

    for _ in range(300):
        async with await _db() as db:
            job = await db.get(ProjectJob, job_id)
            if job.status in {"succeeded", "failed", "cancelled"}:
                return job
        await asyncio.sleep(0.1)
    raise AssertionError("job did not finish")


def test_each_analysis_is_its_runner_with_closed_options():
    from shared_features.analyses import ANALYSES, analysis_named

    by_key = {a.key: a for a in ANALYSES}
    assert set(by_key) == {
        "accessibility",
        "i18n",
        "doc-drift",
        "flaky-tests",
        "tech-debt",
    }
    for analysis in ANALYSES:
        assert (_BACKEND / "runners" / analysis.runner).is_file(), analysis.runner
    a11y = by_key["accessibility"]
    assert a11y.args(a11y.options(target_level="AAA")) == ["--target-level", "AAA"]
    flaky = by_key["flaky-tests"]
    assert flaky.args(flaky.options()) == ["--threshold", "0.05", "--min-runs", "2"]
    assert by_key["tech-debt"].args(by_key["tech-debt"].options()) == [
        "--command",
        "scan",
    ]
    for key, bad in (
        ("accessibility", {"target_level": "--x"}),
        ("accessibility", {"project_path": "/etc"}),
        ("i18n", {"reference_locale": "--help"}),
        ("i18n", {"reference_locale": "../en"}),
        ("flaky-tests", {"threshold": 2}),
        ("tech-debt", {"command": "spec"}),
        ("doc-drift", {"anything": 1}),
    ):
        with pytest.raises(ValueError):
            by_key[key].options.model_validate(bad)
    with pytest.raises(HTTPException) as unknown:
        analysis_named("../roadmap")
    assert unknown.value.status_code == 404


@pytest.mark.asyncio
async def test_a_member_runs_an_analysis_and_every_member_reads_its_report(server):
    from shared_features.analyses import get_analysis_job, get_report, start_analysis

    assert (await get_report("accessibility", _scope(server, "viewer"))) == {
        "report": None
    }
    async with await _db() as db:
        job = await start_analysis(
            "accessibility", _request(), {"target_level": "AAA"}, _scope(server), db
        )
    done = await _wait_final(job["id"])
    assert done.status == "succeeded", done.error
    assert done.feature == "analysis-accessibility"
    async with await _db() as db:
        followed = await get_analysis_job(
            "accessibility", job["id"], 0, _scope(server), db
        )
        # The job of one analysis is not another's.
        with pytest.raises(HTTPException) as other:
            await get_analysis_job("i18n", job["id"], 0, _scope(server), db)
        assert other.value.status_code == 404
    assert followed["lines"][0] == "args --target-level AAA"

    saved = json.loads(
        (await get_report("accessibility", _scope(server, "viewer")))["report"]
    )
    # The last report the runner printed that reads as one.
    assert saved["report"] == {"violations": [{"rule": "alt-text"}], "level": "AAA"}
    assert saved["run_by"] == "u-ada"
    assert saved["finished_at"]
    # Another tenant's project has none of it.
    assert (await get_report("accessibility", _scope(server, which=1))) == {
        "report": None
    }


@pytest.mark.asyncio
async def test_a_runner_that_prints_its_result_as_an_object(server):
    from shared_features.analyses import get_report, start_analysis

    async with await _db() as db:
        job = await start_analysis("tech-debt", _request(), {}, _scope(server), db)
    assert (await _wait_final(job["id"])).status == "succeeded"
    saved = json.loads((await get_report("tech-debt", _scope(server)))["report"])
    assert saved["report"] == {"items": [{"id": "D1", "roi": 3.5}], "trend": [1, 2]}


@pytest.mark.asyncio
async def test_a_failed_analysis_saves_no_report(server):
    from shared_features.analyses import get_report, start_analysis

    async with await _db() as db:
        job = await start_analysis("i18n", _request(), {}, _scope(server), db)
    done = await _wait_final(job["id"])
    assert done.status == "failed"
    assert (await get_report("i18n", _scope(server))) == {"report": None}


@pytest.mark.asyncio
async def test_refusals(server):
    from shared_features.analyses import (
        cancel_analysis_job,
        get_analysis_job,
        get_report,
        start_analysis,
    )

    for kind, body, role, status in (
        ("accessibility", {}, "viewer", 403),
        ("accessibility", {"target_level": "Z"}, "member", 422),
        ("roadmap", {}, "member", 404),
        ("../x", {}, "member", 404),
    ):
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await start_analysis(kind, _request(), body, _scope(server, role), db)
        assert refused.value.status_code == status, (kind, body, role)
    assert not (server["clones"][0] / ".workpilot").exists()

    with pytest.raises(HTTPException) as unknown:
        await get_report("nope", _scope(server))
    assert unknown.value.status_code == 404
    async with await _db() as db:
        with pytest.raises(HTTPException) as missing:
            await get_analysis_job("i18n", "no-such-job", 0, _scope(server), db)
        assert missing.value.status_code == 404
        with pytest.raises(HTTPException) as missing:
            await cancel_analysis_job(
                "i18n", "no-such-job", _request(), _scope(server), db
            )
        assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_a_report_directory_led_out_of_the_clone_is_neither_read_nor_written(
    server, tmp_path
):
    from shared_features.analyses import ANALYSES, _save_report, get_report

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "accessibility.json").write_text('{"secret": true}', encoding="utf-8")
    workpilot = server["clones"][0] / ".workpilot"
    workpilot.mkdir()
    try:
        os.symlink(outside, workpilot / "analyses")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    with pytest.raises(HTTPException) as refused:
        await get_report("accessibility", _scope(server))
    assert refused.value.status_code == 409
    await _save_report(
        ANALYSES[0], server["clones"][0], "u-ada", "succeeded", ['A11Y_RESULT:{"x": 1}']
    )
    assert (outside / "accessibility.json").read_text(encoding="utf-8") == (
        '{"secret": true}'
    )


@pytest.mark.asyncio
async def test_a_workpilot_directory_led_out_of_the_clone_is_not_written(
    server, tmp_path
):
    from shared_features.analyses import ANALYSES, _save_report, get_report

    outside = tmp_path / "outside-workpilot"
    outside.mkdir()
    try:
        # No analyses directory yet: the link is its parent.
        os.symlink(outside, server["clones"][0] / ".workpilot")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    await _save_report(
        ANALYSES[0], server["clones"][0], "u-ada", "succeeded", ['A11Y_RESULT:{"x": 1}']
    )
    assert list(outside.iterdir()) == []
    with pytest.raises(HTTPException) as refused:
        await get_report("accessibility", _scope(server))
    assert refused.value.status_code == 409


def test_running_an_analysis_is_running_an_agent():
    from server.authz.mounting import permission_for

    base = "/api/features/analyses/{kind}"
    assert permission_for("POST", f"{base}/jobs", "insight") == "agent.execute"
    assert permission_for("POST", f"{base}/jobs/{{job_id}}/cancel", "insight") == (
        "agent.cancel"
    )
    assert permission_for("GET", f"{base}/jobs/{{job_id}}", "insight") == "insight.read"
    assert permission_for("GET", f"{base}/report", "insight") == "insight.read"
