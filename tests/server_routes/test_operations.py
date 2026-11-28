"""What the operator watches: the health page, ``/metrics`` and request spans."""

from __future__ import annotations

import re
import subprocess
from collections import namedtuple
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from genai_trace import tracer as tracer_module
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from server.services import metrics, server_health
from server.telemetry import RequestSpans
from sqlalchemy.exc import OperationalError

from tests.server_routes.world import World

HEALTH = "/admin/platform/health"
TOKEN = "m" * 40
Usage = namedtuple("Usage", "total used free")


@pytest.fixture
def landlock(monkeypatch):
    """The kernel's answer, without asking it."""

    def answer(abi):
        monkeypatch.setattr(server_health, "_abi", [abi])

    answer(5)
    return answer


@pytest.fixture
def spans():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer_module.use_tracer_for_tests(provider.get_tracer("test"))
    yield exporter
    tracer_module.reset()


async def _queued(world: World) -> None:
    """A run queued, one running, one done, and a queued job.

    Laid down after a first request: the server's first request settles the
    runs a restart interrupted, these included."""
    await world.call(None, "GET", "/health")
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun, ProjectJob, SpecIndex

    async with get_session_factory()() as db:
        spec = SpecIndex(
            project_id=world.projects["a"],
            spec_name="001-x",
            created_by=world.users["owner_a"],
        )
        db.add(spec)
        await db.flush()
        for status in ("queued", "running", "succeeded"):
            db.add(
                AgentRun(
                    spec_id=spec.id,
                    phase="coding",
                    status=status,
                    started_by=world.users["owner_a"],
                )
            )
        db.add(
            ProjectJob(
                project_id=world.projects["a"],
                feature="roadmap",
                status="queued",
                started_by=world.users["owner_a"],
            )
        )
        await db.commit()


async def test_the_health_page_says_why(world, landlock):
    await _queued(world)
    page = await world.ok("platform", "GET", HEALTH)
    checks = page["checks"]
    assert checks["database"]["status"] == "ok"
    assert checks["database"]["latency_ms"] >= 0
    assert {v["name"] for v in checks["disk"]["volumes"]} == {
        "repositories",
        "database",
    }
    queue = checks["queue"]
    assert (queue["runs_queued"], queue["runs_running"], queue["jobs_queued"]) == (
        1,
        1,
        1,
    )
    assert re.fullmatch(r"\d+\.\d+\.\d+.*", checks["version"]["version"])
    assert checks["isolation"] == {
        "status": "ok",
        "mode": "required",
        "landlock_abi": 5,
    }
    # The periodic jobs run in the server's lifespan, not in these requests.
    assert checks["jobs"]["usage_retention"] == "off"
    assert page["status"] == server_health.worst([c["status"] for c in checks.values()])
    assert "example.com" not in str(page) and str(world.tmp) not in str(page)


async def test_the_jobs_while_the_server_runs(world, landlock):
    async with world.app.router.lifespan_context(world.app):
        from server.db.engine import get_session_factory

        async with get_session_factory()() as db:
            jobs = (await server_health.report(db))["checks"]["jobs"]
    assert jobs["usage_retention"] == "running" and jobs["status"] == "ok"


def test_a_stopped_job_degrades_the_page(monkeypatch):
    from server.services import approval_escalation, usage_retention

    class Done:
        def done(self) -> bool:
            return True

    monkeypatch.setattr(usage_retention, "_task", Done())
    monkeypatch.setattr(approval_escalation, "_task", Done())
    jobs = server_health.jobs()
    assert jobs == {
        "status": "degraded",
        "approval_escalation": "stopped",
        "usage_retention": "stopped",
    }

    class Running:
        def done(self) -> bool:
            return False

    monkeypatch.setattr(usage_retention, "_task", Running())
    assert server_health.jobs()["status"] == "degraded"
    monkeypatch.setattr(approval_escalation, "_task", None)
    assert server_health.jobs()["status"] == "ok"


def test_isolation_as_the_operator_asks_it(monkeypatch, landlock):
    from server.services import run_isolation

    monkeypatch.setenv(run_isolation.ISOLATION_ENV, "off")
    assert server_health.isolation()["status"] == "degraded"
    monkeypatch.delenv(run_isolation.ISOLATION_ENV)
    landlock(None)
    assert server_health.isolation() == {
        "status": "error",
        "mode": "required",
        "landlock_abi": None,
    }


def test_the_landlock_probe_runs_once(monkeypatch):
    calls: list[list[str]] = []

    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["check"] is False and "shell" not in kwargs
        return subprocess.CompletedProcess(args, 0, stdout="6\n", stderr="")

    monkeypatch.setattr(server_health, "_abi", [])
    monkeypatch.setattr(server_health.subprocess, "run", run)
    assert server_health.landlock_abi() == 6
    assert server_health.landlock_abi() == 6 and len(calls) == 1

    for result in (
        subprocess.CompletedProcess([], 1, stdout="", stderr="no"),
        subprocess.CompletedProcess([], 0, stdout="nope", stderr=""),
    ):
        monkeypatch.setattr(
            server_health.subprocess, "run", lambda *a, r=result, **k: r
        )
        assert server_health._probe_landlock() is None

    def broken(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("python", 20)

    monkeypatch.setattr(server_health.subprocess, "run", broken)
    assert server_health._probe_landlock() is None


def test_the_real_probe_answers_a_number_or_nothing():
    abi = server_health._probe_landlock()
    assert abi is None or abi >= 1


@pytest.mark.parametrize(
    ("free", "status"),
    [(50, "ok"), (9, "degraded"), (1, "error")],
)
def test_free_space_thresholds(monkeypatch, tmp_path, free, status):
    monkeypatch.setattr(
        server_health.shutil, "disk_usage", lambda _p: Usage(100, 100 - free, free)
    )
    volume = server_health._volume("data", tmp_path / "not" / "yet")
    assert volume["status"] == status and volume["free_percent"] == float(free)


def test_a_volume_that_cannot_be_read(monkeypatch, tmp_path):
    def refused(_path):
        raise PermissionError("no")

    monkeypatch.setattr(server_health.shutil, "disk_usage", refused)
    assert server_health._volume("data", tmp_path) == {
        "name": "data",
        "status": "error",
        "error": "PermissionError",
    }
    monkeypatch.setattr(server_health.shutil, "disk_usage", lambda _p: Usage(0, 0, 0))
    assert server_health._volume("data", tmp_path)["status"] == "error"


@pytest.mark.parametrize(
    ("url", "file"),
    [
        ("sqlite+aiosqlite:////srv/wp.db", "/srv/wp.db"),
        ("sqlite+aiosqlite:///:memory:", None),
        ("postgresql+asyncpg://db/wp", None),
        ("sqlite://", None),
    ],
)
def test_only_a_sqlite_file_is_a_volume(url, file):
    found = server_health._sqlite_file(url)
    assert (str(found) if found else None) == file


def test_a_server_database_is_no_volume(monkeypatch, tmp_path):
    class Settings:
        repos_root = str(tmp_path)
        database_url = "postgresql+asyncpg://db/wp"

    monkeypatch.setattr(server_health, "get_settings", lambda: Settings())
    found = server_health.disk()
    assert [v["name"] for v in found["volumes"]] == ["repositories"]


async def test_a_database_that_does_not_answer():
    class Down:
        async def execute(self, *_args):
            raise OperationalError("SELECT 1", {}, Exception("down"))

    assert await server_health.database(Down()) == {  # type: ignore[arg-type]
        "status": "error",
        "error": "OperationalError",
    }


async def test_the_schema_revision_when_there_is_one():
    class Migrated:
        async def execute(self, *_args):
            return None

        async def scalar(self, *_args):
            return "0046_page_visits"

    found = await server_health.database(Migrated())  # type: ignore[arg-type]
    assert found["revision"] == "0046_page_visits"


def test_the_version_as_the_release_writes_it(monkeypatch, tmp_path):
    assert server_health.version() != "unknown"
    monkeypatch.setattr(server_health, "_BACKEND_DIR", tmp_path)
    assert server_health.version() == "unknown"
    (tmp_path / "__init__.py").write_text("x = 1\n", encoding="utf-8")
    assert server_health.version() == "unknown"
    assert server_health.worst([]) == "ok"
    assert server_health.worst(["ok", "off", "degraded"]) == "degraded"


def _token(monkeypatch, value: str) -> None:
    from server import config

    monkeypatch.setenv("WORKPILOT_METRICS_TOKEN", value)
    config.reset_settings_cache()


async def test_metrics_are_closed_without_their_token(world, monkeypatch, landlock):
    assert (await world.call(None, "GET", "/metrics")).status_code == 404
    _token(monkeypatch, "short")
    assert (await world.call(None, "GET", "/metrics")).status_code == 404
    _token(monkeypatch, TOKEN)
    for headers in (
        {},
        {"Authorization": "Bearer " + "x" * 40},
        {"Authorization": TOKEN},
    ):
        answer = await world.client.get("/metrics", headers=headers)
        assert answer.status_code == 401
        assert answer.headers["www-authenticate"] == "Bearer"
    # A person's session does not open them either.
    assert (await world.call("platform", "GET", "/metrics")).status_code == 401


async def test_metrics_in_the_prometheus_format(world, monkeypatch, landlock):
    from datetime import UTC, datetime

    from server.db.engine import get_session_factory
    from server.db.models import PresenceDay, UsageRecord

    await _queued(world)
    now = datetime.now(UTC)
    async with get_session_factory()() as db:
        for org, provider, tokens in (
            ("a", "anthropic", 700),
            ("a", None, 30),
            ("b", "openai", 50),
        ):
            db.add(
                UsageRecord(
                    org_id=world.orgs[org],
                    user_id=world.users["owner_a"],
                    phase="coding",
                    provider=provider,
                    input_tokens=tokens,
                    output_tokens=0,
                    cost_micro_usd=0,
                    created_at=now,
                )
            )
        db.add(
            PresenceDay(
                user_id=world.users["owner_a"],
                org_id=world.orgs["a"],
                day=now.date(),
                last_seen_at=now,
            )
        )
        await db.commit()
    _token(monkeypatch, TOKEN)
    answer = await world.client.get(
        "/metrics", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert answer.status_code == 200
    assert answer.headers["content-type"] == metrics.CONTENT_TYPE
    body = answer.text
    assert "# TYPE workpilot_runs gauge" in body
    assert 'workpilot_runs{status="queued"} 1' in body
    assert 'workpilot_jobs{status="queued"} 1' in body
    assert 'workpilot_tokens_this_month{org="acme",provider="anthropic"} 700' in body
    assert 'workpilot_tokens_this_month{org="acme",provider="unknown"} 30' in body
    assert 'workpilot_tokens_this_month{org="globex",provider="openai"} 50' in body
    assert 'workpilot_active_people_today{org="acme"} 1' in body
    assert "workpilot_landlock_abi 5" in body
    assert 'workpilot_health_status{check="database"} 0' in body
    assert re.search(r"^workpilot_accounts \d+$", body, re.M)
    assert "example.com" not in body and world.users["owner_a"] not in body


def test_a_label_is_escaped():
    out = metrics.Exposition()
    out.gauge("x", "help", [({"v": 'a"b\\c\nd'}, 1)])
    assert out.lines[-1] == 'x{v="a\\"b\\\\c\\nd"} 1'
    out.gauge("y", "help", [({}, -1)])
    assert out.text().endswith("y -1\n")


def _tiny() -> FastAPI:
    app = FastAPI()

    @app.get("/things/{thing_id}")
    async def thing(thing_id: str) -> dict:
        return {"id": thing_id}

    @app.get("/broken")
    async def broken() -> JSONResponse:
        return JSONResponse({"detail": "no"}, status_code=503)

    @app.get("/raises")
    async def raises() -> None:
        raise RuntimeError("boom")

    app.add_middleware(RequestSpans)
    return app


async def _get(app: FastAPI, path: str) -> int:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        return (await client.get(path)).status_code


async def test_each_request_becomes_a_span_without_its_path(spans):
    app = _tiny()
    assert await _get(app, "/things/secret-id") == 200
    assert await _get(app, "/broken") == 503
    assert await _get(app, "/raises") == 500
    assert await _get(app, "/nowhere") == 404
    by_name = {s.name: s for s in spans.get_finished_spans()}
    thing = by_name["GET /things/{thing_id}"]
    assert dict(thing.attributes) == {
        "http.request.method": "GET",
        "url.scheme": "http",
        "http.route": "/things/{thing_id}",
        "http.response.status_code": 200,
    }
    assert by_name["GET /broken"].attributes["error.type"] == "503"
    assert by_name["GET /raises"].attributes["error.type"] == "RuntimeError"
    assert by_name["HTTP GET"].attributes["http.response.status_code"] == 404
    assert all("secret-id" not in str(dict(s.attributes)) for s in by_name.values())


async def test_without_a_collector_nothing_is_traced():
    tracer_module.use_tracer_for_tests(None)
    try:
        assert await _get(_tiny(), "/things/1") == 200
    finally:
        tracer_module.reset()


async def test_the_server_traces_its_routes(world, spans, landlock):
    await world.ok("platform", "GET", HEALTH)
    names = {s.name for s in spans.get_finished_spans()}
    assert f"GET {HEALTH}" in names


def test_the_backend_dir_holds_the_version_file():
    assert (Path(server_health.__file__).resolve().parents[2] / "__init__.py").is_file()
