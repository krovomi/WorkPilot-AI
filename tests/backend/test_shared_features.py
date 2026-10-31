"""Server mode: a project's shared features, roadmap first.

On the desktop the roadmap is a file on the person's computer and its runner
runs there. On a shared server both are the server's: these tests hold its
files to what the feature declares, a rewrite to the version the member read,
a job to the feature's runner with a closed list of options, and turning a
roadmap feature into a card to the shared board.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def events(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "features.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.services import project_jobs
    from shared_features import api, roadmap

    sent: list[tuple[str, str, dict]] = []

    def record(project_id, event, data):
        sent.append((project_id, event, data))

    for module in (api, roadmap, project_jobs):
        monkeypatch.setattr(module, "emit_board_event", record)
    monkeypatch.setattr(project_jobs, "_jobs", None)
    yield sent
    server_config.reset_settings_cache()


async def _project(tmp_path: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "repos" / "clone"
    clone.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        project = Project(
            org_id=org.id, name="P", repo_url="https://x/p.git", server_path=str(clone)
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone


def _scope(project_id, org_id, clone, role="member"):
    from server.authz.scope import ProjectScope

    return ProjectScope(project_id, org_id, clone, role)


def _request(**principal):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(**{"id": "u-1", "email": "a@x", **principal})
    return request


def _routes():
    from shared_features.api import feature_router
    from shared_features.registry import ROADMAP

    return {
        (
            next(iter(r.methods)),
            r.path.removeprefix("/api/features/roadmap"),
        ): r.endpoint
        for r in feature_router(ROADMAP).routes
    }


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _roadmap(clone: Path, value: dict) -> str:
    directory = clone / ".workpilot" / "roadmap"
    directory.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value)
    (directory / "roadmap.json").write_text(text, encoding="utf-8")
    return text


async def _session():
    from server.db.engine import get_session_factory

    return get_session_factory()()


@pytest.mark.asyncio
async def test_a_snapshot_serves_only_the_declared_files(tmp_path):
    project_id, org_id, clone = await _project(tmp_path)
    text = _roadmap(clone, {"features": []})
    directory = clone / ".workpilot" / "roadmap"
    (directory / "notes.txt").write_text("not served", encoding="utf-8")
    (directory / "competitor_analysis.json").write_text(
        "x" * 1_000_001, encoding="utf-8"
    )
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    try:
        (directory / "roadmap_discovery.json").symlink_to(outside)
    except OSError:
        pass  # no symlinks for this user (Windows): the rest still holds

    async with await _session() as db:
        result = await _routes()[("GET", "/snapshot")](
            scope=_scope(project_id, org_id, clone, "viewer"), db=db
        )
    assert result["files"] == {"roadmap.json": {"content": text, "sha256": _sha(text)}}
    assert result["job"] is None


@pytest.mark.asyncio
async def test_a_member_rewrites_the_roadmap_only_from_what_they_read(tmp_path, events):
    from fastapi import HTTPException
    from shared_features.api import FileWrite

    project_id, org_id, clone = await _project(tmp_path)
    text = _roadmap(clone, {"features": [{"id": "f1", "status": "under_review"}]})
    write = _routes()[("PUT", "/files/{name}")]
    scope = _scope(project_id, org_id, clone)
    edited = json.dumps({"features": [{"id": "f1", "status": "planned"}]})

    result = await write(
        name="roadmap.json",
        request=_request(),
        body=FileWrite(content=edited, base_sha256=_sha(text)),
        scope=scope,
    )
    assert result == {"sha256": _sha(edited)}
    on_disk = (clone / ".workpilot" / "roadmap" / "roadmap.json").read_text("utf-8")
    assert on_disk == edited
    assert events[-1][1] == "feature_updated"

    refusals = [
        # A teammate saved in between: the version read is stale.
        ("roadmap.json", FileWrite(content=edited, base_sha256=_sha(text)), 409),
        # Written as new while it exists.
        ("roadmap.json", FileWrite(content=edited), 409),
        ("competitor_analysis.json", FileWrite(content="{}"), 404),
        ("../../.git/config", FileWrite(content="{}"), 404),
        ("roadmap.json", FileWrite(content="[]", base_sha256=_sha(edited)), 422),
        ("roadmap.json", FileWrite(content="nope", base_sha256=_sha(edited)), 422),
    ]
    for name, body, status in refusals:
        with pytest.raises(HTTPException) as refused:
            await write(name=name, request=_request(), body=body, scope=scope)
        assert refused.value.status_code == status, (name, body)

    with pytest.raises(HTTPException) as viewer:
        await write(
            name="roadmap.json",
            request=_request(),
            body=FileWrite(content=edited, base_sha256=_sha(edited)),
            scope=_scope(project_id, org_id, clone, "viewer"),
        )
    assert viewer.value.status_code == 403


@pytest.mark.asyncio
async def test_nothing_is_rewritten_while_a_job_writes_the_feature(tmp_path):
    from fastapi import HTTPException
    from server.services.project_jobs import get_project_jobs
    from shared_features.api import FileWrite

    project_id, org_id, clone = await _project(tmp_path)
    text = _roadmap(clone, {"features": []})
    get_project_jobs()._running[(project_id, "roadmap")] = "job-1"
    with pytest.raises(HTTPException) as busy:
        await _routes()[("PUT", "/files/{name}")](
            name="roadmap.json",
            request=_request(),
            body=FileWrite(content="{}", base_sha256=_sha(text)),
            scope=_scope(project_id, org_id, clone),
        )
    assert busy.value.status_code == 409


def test_job_options_are_a_closed_list():
    from shared_features.registry import ROADMAP

    def args(options):
        return ROADMAP.args(ROADMAP.options.model_validate(options))

    assert args({}) == []
    assert args(
        {
            "refresh": True,
            "competitor_analysis": True,
            "model": "claude-sonnet-5-5",
            "thinking_level": "high",
        }
    ) == [
        "--model",
        "claude-sonnet-5-5",
        "--thinking-level",
        "high",
        "--refresh",
        "--competitor-analysis",
    ]
    for bad in (
        {"model": "--output=/etc"},
        {"model": "a b"},
        {"thinking_level": "max"},
        {"project": "/other"},
        {"output": "/tmp/x"},
    ):
        with pytest.raises(ValueError):
            ROADMAP.options.model_validate(bad)


def test_every_feature_job_needs_the_right_to_run_an_agent():
    from server.authz.catalog import domain_for_feature
    from server.authz.mounting import permission_for
    from shared_features.registry import FEATURES

    for key in FEATURES:
        base = f"/api/features/{key}"
        domain = domain_for_feature(key)
        assert domain == "insight"
        assert permission_for("POST", f"{base}/jobs", domain) == "agent.execute"
        assert (
            permission_for("POST", f"{base}/jobs/{{job_id}}/cancel", domain)
            == "agent.cancel"
        )
        assert permission_for("GET", f"{base}/snapshot", domain) == "insight.read"
        assert (
            permission_for("PUT", f"{base}/files/{{name}}", domain) == "insight.write"
        )
    assert (
        permission_for(
            "POST", "/api/features/roadmap/features/{feature_id}/convert", "insight"
        )
        == "task.write"
    )


_FAKE_RUNNER = """
import pathlib, sys, time
args = sys.argv[1:]
project = pathlib.Path(args[args.index("--project") + 1])
print("args", " ".join(args[2:]), flush=True)
if "--slow" in args or pathlib.Path(project, "slow").exists():
    time.sleep(30)
out = project / ".workpilot" / "roadmap"
out.mkdir(parents=True, exist_ok=True)
(out / "roadmap.json").write_text('{"features": []}', encoding="utf-8")
print("done", flush=True)
"""


async def _wait_final(job_id: str, timeout: float = 30.0):
    from server.db.models import ProjectJob

    for _ in range(int(timeout * 10)):
        async with await _session() as db:
            job = await db.get(ProjectJob, job_id)
            if job.status in {"succeeded", "failed", "cancelled"}:
                return job
        await asyncio.sleep(0.1)
    raise AssertionError("job did not finish")


@pytest.fixture
def fake_runner(tmp_path, monkeypatch):
    from server.services import project_jobs
    from shared_features import registry

    backend = tmp_path / "backend"
    (backend / "runners").mkdir(parents=True)
    (backend / "runners" / "roadmap_runner.py").write_text(
        _FAKE_RUNNER, encoding="utf-8"
    )
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", backend)
    # Confinement is proven in test_run_isolation; here, what the job runs.
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    return registry


@pytest.mark.asyncio
async def test_a_job_runs_the_features_runner_on_the_clone(
    tmp_path, fake_runner, events
):
    from fastapi import HTTPException

    project_id, org_id, clone = await _project(tmp_path)
    routes = _routes()
    scope = _scope(project_id, org_id, clone)
    job = await routes[("POST", "/jobs")](
        request=_request(),
        options={"refresh": True, "model": "sonnet"},
        scope=scope,
    )
    assert job["status"] == "queued"
    done = await _wait_final(job["id"])
    assert done.status == "succeeded", done.error

    async with await _session() as db:
        followed = await routes[("GET", "/jobs/{job_id}")](
            job_id=job["id"], after=0, scope=scope, db=db
        )
    assert followed["lines"] == ["args --model sonnet --refresh", "done"]
    assert followed["next"] == 2
    async with await _session() as db:
        later = await routes[("GET", "/jobs/{job_id}")](
            job_id=job["id"], after=1, scope=scope, db=db
        )
    assert later["lines"] == ["done"]
    assert (clone / ".workpilot" / "roadmap" / "roadmap.json").exists()
    statuses = [d["status"] for _, e, d in events if e == "feature_job"]
    assert statuses == ["running", "succeeded"]

    async with await _session() as db:
        snapshot = await routes[("GET", "/snapshot")](scope=scope, db=db)
    assert snapshot["job"]["id"] == job["id"]
    assert "roadmap.json" in snapshot["files"]

    # A viewer neither starts nor stops a job.
    with pytest.raises(HTTPException) as viewer:
        await routes[("POST", "/jobs")](
            request=_request(),
            options={},
            scope=_scope(project_id, org_id, clone, "viewer"),
        )
    assert viewer.value.status_code == 403


@pytest.mark.asyncio
async def test_one_job_per_feature_and_it_can_be_stopped(tmp_path, fake_runner):
    from fastapi import HTTPException
    from server.services.quotas import count_active_runs

    project_id, org_id, clone = await _project(tmp_path)
    (clone / "slow").write_text("", encoding="utf-8")
    routes = _routes()
    scope = _scope(project_id, org_id, clone)
    job = await routes[("POST", "/jobs")](request=_request(), options={}, scope=scope)
    with pytest.raises(HTTPException) as second:
        await routes[("POST", "/jobs")](request=_request(), options={}, scope=scope)
    assert second.value.status_code == 409
    async with await _session() as db:
        assert await count_active_runs(db, org_id) == 1

    from server.services.project_jobs import get_project_jobs

    for _ in range(100):
        if job["id"] in get_project_jobs()._active:
            break
        await asyncio.sleep(0.1)
    async with await _session() as db:
        stopped = await routes[("POST", "/jobs/{job_id}/cancel")](
            job_id=job["id"], request=_request(), scope=scope, db=db
        )
    assert stopped == {"cancelled": True}
    assert (await _wait_final(job["id"])).status == "cancelled"
    async with await _session() as db:
        assert await count_active_runs(db, org_id) == 0
        with pytest.raises(HTTPException) as unknown:
            await routes[("GET", "/jobs/{job_id}")](
                job_id="not-a-job", after=0, scope=scope, db=db
            )
    assert unknown.value.status_code == 404


@pytest.mark.asyncio
async def test_a_roadmap_feature_becomes_a_card_of_the_shared_board(tmp_path, events):
    from fastapi import HTTPException
    from shared_features.roadmap import convert_feature

    project_id, org_id, clone = await _project(tmp_path)
    _roadmap(
        clone,
        {
            "features": [
                {
                    "id": "f1",
                    "title": "Export to CSV",
                    "description": "Let people export.",
                    "user_stories": ["As a user I export"],
                    "acceptance_criteria": ["A CSV downloads"],
                    "status": "under_review",
                }
            ]
        },
    )
    scope = _scope(project_id, org_id, clone)
    async with await _session() as db:
        result = await convert_feature(
            feature_id="f1", request=_request(), scope=scope, db=db
        )
    card_id = result["card"]["id"]
    card = clone / ".workpilot" / "specs" / card_id
    metadata = json.loads((card / "task_metadata.json").read_text("utf-8"))
    assert metadata["sourceType"] == "roadmap" and metadata["featureId"] == "f1"
    requirements = json.loads((card / "requirements.json").read_text("utf-8"))
    assert "- [ ] A CSV downloads" in requirements["task_description"]
    assert not (card / "spec.md").exists()  # the spec phase writes it

    roadmap_text = (clone / ".workpilot" / "roadmap" / "roadmap.json").read_text(
        "utf-8"
    )
    feature = json.loads(roadmap_text)["features"][0]
    assert feature["linked_spec_id"] == card_id and feature["status"] == "planned"
    assert result["roadmap_sha256"] == _sha(roadmap_text)
    assert {e for _, e, _ in events} >= {"spec_created", "feature_updated"}

    for feature_id, role, status in (
        ("f1", "member", 409),  # already a card
        ("nope", "member", 404),
        ("f1", "viewer", 403),
    ):
        async with await _session() as db:
            with pytest.raises(HTTPException) as refused:
                await convert_feature(
                    feature_id=feature_id,
                    request=_request(),
                    scope=_scope(project_id, org_id, clone, role),
                    db=db,
                )
        assert refused.value.status_code == status


def test_a_feature_directory_led_out_of_the_clone_is_refused(tmp_path):
    from fastapi import HTTPException
    from shared_features.api import feature_dir
    from shared_features.registry import ROADMAP

    clone = tmp_path / "clone"
    (clone / ".workpilot").mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    try:
        os.symlink(elsewhere, clone / ".workpilot" / "roadmap")
    except OSError:
        pytest.skip("no symlinks for this user")
    with pytest.raises(HTTPException) as refused:
        feature_dir(_scope("p", "o", clone), ROADMAP)
    assert refused.value.status_code == 409


@pytest.mark.asyncio
async def test_a_job_left_running_by_a_stopped_server_is_settled(tmp_path):
    from server.db.models import ProjectJob
    from server.services.project_jobs import INTERRUPTED
    from server.services.quotas import count_active_runs

    project_id, org_id, clone = await _project(tmp_path)
    async with await _session() as db:
        db.add(ProjectJob(project_id=project_id, feature="roadmap", status="running"))
        await db.commit()
        assert await count_active_runs(db, org_id) == 1

    async with await _session() as db:
        snapshot = await _routes()[("GET", "/snapshot")](
            scope=_scope(project_id, org_id, clone, "viewer"), db=db
        )
    assert snapshot["job"]["status"] == "failed"
    assert snapshot["job"]["error"] == INTERRUPTED
    async with await _session() as db:
        assert await count_active_runs(db, org_id) == 0
