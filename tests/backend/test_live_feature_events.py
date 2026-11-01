"""Server mode: what a shared view of a project hears live.

The app keeps the project's stream (``project:<id>``) open while one of its
shared views is shown (``apps/frontend/src/main/server-live-views.ts``) and
reads the view again when a teammate changes it. These tests hold the server
to its side: a feature rewrite and each step of a job, from the queue to its
end, go out on the project's channel; an event names the feature, the file
or the job and who did it, never a path or a file's content; a refused
rewrite says nothing; and every event the app follows is one the stream
knows (an unknown type is dropped by the stream, so the view would never
hear it).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_BACKEND = _ROOT / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_APP_MAIN = _ROOT / "apps" / "frontend" / "src" / "main"

_FAKE_RUNNER = """
import pathlib, sys
args = sys.argv[1:]
project = pathlib.Path(args[args.index("--project") + 1])
out = project / ".workpilot" / "roadmap"
out.mkdir(parents=True, exist_ok=True)
(out / "roadmap.json").write_text('{"features": []}', encoding="utf-8")
print("done", flush=True)
"""


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
        "sqlite+aiosqlite:///" + str(tmp_path / "live.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.services import project_jobs
    from shared_features import api

    sent: list[tuple[str, str, dict]] = []

    def record(project_id, event, data):
        sent.append((project_id, event, data))

    for module in (api, project_jobs):
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


def _request():
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "PUT", "path": "/", "headers": []})
    request.state.principal = Principal(id="u-1", email="a@x")
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


def _no_path(data: dict, clone: Path) -> None:
    for value in data.values():
        assert str(clone) not in str(value)
        assert "/" not in str(value) and "\\" not in str(value), value


def _ts_strings(source: Path, constant: str) -> set[str]:
    text = source.read_text(encoding="utf-8")
    block = re.search(
        rf"export const {constant}\b[^=]*=\s*(?:new Set\()?\[(.*?)\]", text, re.S
    )
    assert block, f"{constant} not found in {source.name}"
    return set(re.findall(r'"([a-z_]+)"', block.group(1)))


def test_every_event_the_app_follows_is_a_type_of_the_stream():
    from streaming.streaming_manager import EventType

    known = {member.value for member in EventType}
    views = _ts_strings(_APP_MAIN / "server-live-views.ts", "LIVE_VIEW_EVENTS")
    board = _ts_strings(_APP_MAIN / "server-board-live.ts", "BOARD_EVENTS")
    assert views >= {"feature_updated", "feature_job", "insights_updated"}
    assert views | board <= known, (views | board) - known


@pytest.mark.asyncio
async def test_an_event_goes_out_on_the_projects_channel_only(monkeypatch):
    from server.services import events as board_events

    channels: list[tuple[str, str]] = []

    async def fake_send(channel, event_type, data):
        channels.append((channel, event_type))

    monkeypatch.setattr(board_events, "_send", fake_send)
    board_events.emit_board_event("p-1", "feature_updated", {"feature": "roadmap"})
    await asyncio.sleep(0)
    assert channels == [("project:p-1", "feature_updated")]


@pytest.mark.asyncio
async def test_a_feature_rewrite_says_which_file_and_who_never_what(tmp_path, events):
    from fastapi import HTTPException
    from shared_features.api import FileWrite

    project_id, org_id, clone = await _project(tmp_path)
    directory = clone / ".workpilot" / "roadmap"
    directory.mkdir(parents=True)
    text = json.dumps({"features": []})
    (directory / "roadmap.json").write_text(text, encoding="utf-8")
    write = _routes()[("PUT", "/files/{name}")]
    scope = _scope(project_id, org_id, clone)
    edited = json.dumps({"features": [{"id": "f1", "title": "secret plan"}]})

    await write(
        name="roadmap.json",
        request=_request(),
        body=FileWrite(content=edited, base_sha256=_sha(text)),
        scope=scope,
    )
    assert events == [
        (
            project_id,
            "feature_updated",
            {"feature": "roadmap", "file": "roadmap.json", "by": "u-1"},
        )
    ]
    _no_path(events[0][2], clone)
    assert "secret plan" not in json.dumps(events)

    # Refused: a teammate saved in between. Nothing changed, nothing is said.
    with pytest.raises(HTTPException) as stale:
        await write(
            name="roadmap.json",
            request=_request(),
            body=FileWrite(content=text, base_sha256=_sha(text)),
            scope=scope,
        )
    assert stale.value.status_code == 409
    assert len(events) == 1


async def _wait_final(job_id: str, timeout: float = 30.0):
    from server.db.engine import get_session_factory
    from server.db.models import ProjectJob

    for _ in range(int(timeout * 10)):
        async with get_session_factory()() as db:
            job = await db.get(ProjectJob, job_id)
            if job.status in {"succeeded", "failed", "cancelled"}:
                return job
        await asyncio.sleep(0.1)
    raise AssertionError("job did not finish")


@pytest.mark.asyncio
async def test_a_job_is_announced_from_the_queue_to_its_end(
    tmp_path, events, monkeypatch
):
    from server.services import project_jobs

    backend = tmp_path / "backend"
    (backend / "runners").mkdir(parents=True)
    (backend / "runners" / "roadmap_runner.py").write_text(
        _FAKE_RUNNER, encoding="utf-8"
    )
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", backend)
    # Confinement is proven in test_run_isolation; here, what is announced.
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")

    project_id, org_id, clone = await _project(tmp_path)
    job = await _routes()[("POST", "/jobs")](
        request=_request(), options={}, scope=_scope(project_id, org_id, clone)
    )
    # Announced before it waits for a slot: a teammate's view follows it now.
    assert events == [
        (
            project_id,
            "feature_job",
            {
                "feature": "roadmap",
                "job_id": job["id"],
                "status": "queued",
                "by": "u-1",
            },
        )
    ]
    done = await _wait_final(job["id"])
    assert done.status == "succeeded", done.error
    assert [d["status"] for _, e, d in events if e == "feature_job"] == [
        "queued",
        "running",
        "succeeded",
    ]
    for pid, _, data in events:
        assert pid == project_id
        assert set(data) == {"feature", "job_id", "status", "by"}
        _no_path(data, clone)
