"""The Context Mesh runner, as the desktop app starts it.

The mesh lives in `~/.workpilot/context_mesh`: each test gives the runner its
own home folder, registers real projects, reads the summary and the
recommendations back, and runs an analysis. The analysis of registered
projects calls a model, so that one runs in-process with a stand-in answer.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "context_mesh_runner.py"


def _run(home: Path, *args: str) -> tuple[int, list[dict]]:
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    done = subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
        check=False,
    )
    events = [
        json.loads(line.split(":", 1)[1])
        for line in done.stdout.splitlines()
        if line.startswith("CONTEXT_MESH_EVENT:")
    ]
    return done.returncode, events


def _mesh(home: Path) -> Path:
    return home / ".workpilot" / "context_mesh"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    return folder


@pytest.fixture
def projects(tmp_path: Path) -> tuple[Path, Path]:
    web = tmp_path / "web"
    web.mkdir()
    (web / "package.json").write_text(
        json.dumps({"dependencies": {"react": "19.0.0"}}), encoding="utf-8"
    )
    (web / "app.tsx").write_text("export {}\n", encoding="utf-8")
    api = tmp_path / "api"
    api.mkdir()
    (api / "pyproject.toml").write_text(
        '[project]\nname = "api"\ndependencies = ["fastapi"]\n', encoding="utf-8"
    )
    (api / "main.py").write_text("print('hi')\n", encoding="utf-8")
    return web, api


def test_projects_are_registered_counted_and_unregistered(home, projects):
    web, api = projects
    code, events = _run(home, "register", "--project-dir", str(web))
    assert code == 0
    [done] = events
    assert done["message"] == "Registered project: web"
    assert done["data"]["project"]["project_path"] == str(web.resolve())
    assert _run(home, "register", "--project-dir", str(api))[0] == 0

    code, events = _run(home, "summary")
    assert code == 0
    assert events[-1]["data"]["summary"]["project_count"] == 2

    code, events = _run(home, "unregister", "--project-dir", str(web.resolve()))
    assert code == 0
    assert events[-1]["message"] == f"Unregistered project: {web.resolve()}"
    assert _run(home, "summary")[1][-1]["data"]["summary"]["project_count"] == 1


def test_an_empty_mesh_analyses_to_an_empty_report(home) -> None:
    code, events = _run(home, "analyze", "--model", "haiku", "--thinking-level", "low")
    assert code == 0
    assert events[0] == {
        "type": "status",
        "data": {"progress": 100},
        "message": "Analysis complete",
    }
    report = events[-1]["data"]["report"]
    assert report["analyzed_projects"] == [] and report["recommendations"] == []
    assert events[-1]["data"]["summary"]["project_count"] == 0


def test_recommendations_are_the_active_ones_for_the_phase_best_first(
    home, projects
) -> None:
    web, _ = projects
    mesh = _mesh(home)
    mesh.mkdir(parents=True)

    def rec(rid, score, phase="", status="active", target=str(web)):
        return {
            "recommendation_id": rid,
            "recommendation_type": "pattern_reuse",
            "title": rid,
            "description": "",
            "source_project": "api",
            "target_project": target,
            "relevance_score": score,
            "phase": phase,
            "status": status,
        }

    (mesh / "recommendations.json").write_text(
        json.dumps(
            {
                "recommendations": [
                    rec("any-phase", 0.4),
                    rec("coding", 0.9, phase="coding"),
                    rec("qa-only", 1.0, phase="qa"),
                    rec("dismissed", 1.0, status="dismissed"),
                    rec("other-project", 1.0, target="/elsewhere"),
                ]
            }
        ),
        encoding="utf-8",
    )
    code, events = _run(
        home, "recommendations", "--project-dir", str(web), "--phase", "coding"
    )
    assert code == 0
    found = events[-1]["data"]["recommendations"]
    assert [r["recommendation_id"] for r in found] == ["coding", "any-phase"]


def test_a_command_is_required(home) -> None:
    code, events = _run(home)
    assert code == 2 and events == []


# --- in-process: an analysis with a model answer, and every failure path ----------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch, home: Path):
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.syspath_prepend(str(BACKEND))
    import context_mesh.storage as storage

    monkeypatch.setattr(storage, "DEFAULT_MESH_DIR", str(_mesh(home)))
    spec = importlib.util.spec_from_file_location("context_mesh_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _events(capsys) -> list[dict]:
    return [
        json.loads(line.split(":", 1)[1])
        for line in capsys.readouterr().out.splitlines()
    ]


def test_an_analysis_streams_its_status_and_saves_the_report(
    runner, projects, monkeypatch, capsys, home
) -> None:
    from context_mesh.mesh_service import ContextMeshService

    web, api = projects
    service = ContextMeshService()
    service.register_project(str(web))
    service.register_project(str(api))
    capsys.readouterr()

    async def model(self, prompt, projects):
        assert "web" in prompt and "api" in prompt
        return json.dumps({"patterns": [], "recommendations": []})

    monkeypatch.setattr(ContextMeshService, "_run_ai_analysis", model)
    asyncio.run(runner.run_analysis())
    events = _events(capsys)
    statuses = [e["message"] for e in events if e["type"] == "status"]
    assert statuses[0] == "Analyzing 2 project(s)..."
    assert statuses[-1] == "Analysis complete"
    chunks = [e["data"] for e in events if e["type"] == "stream_chunk"]
    assert chunks[0] == "[Status] Analyzing 2 project(s)...\n"
    assert events[-1]["type"] == "complete"
    assert (_mesh(home) / "last_report.json").is_file()


@pytest.mark.parametrize(
    ("argv", "target"),
    [
        (["analyze"], "context_mesh.mesh_service.ContextMeshService.run_analysis"),
        (
            ["register", "--project-dir", "x"],
            "context_mesh.mesh_service.ContextMeshService.register_project",
        ),
        (
            ["unregister", "--project-dir", "x"],
            "context_mesh.mesh_service.ContextMeshService.unregister_project",
        ),
        (["summary"], "context_mesh.storage.ContextMeshStorage.get_summary"),
        (
            ["recommendations", "--project-dir", "x"],
            "context_mesh.mesh_service.ContextMeshService.get_recommendations_for_project",
        ),
    ],
)
def test_each_command_reports_its_failure(
    runner, monkeypatch, capsys, argv, target
) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    async def aboom(*_a, **_k):
        raise RuntimeError("disk full")

    is_async = target.endswith(("run_analysis", "get_recommendations_for_project"))
    monkeypatch.setattr(target, aboom if is_async else boom)
    monkeypatch.setattr(sys, "argv", ["runner", *argv])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    assert _events(capsys)[-1] == {"type": "error", "message": "disk full"}


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (KeyboardInterrupt, "Operation cancelled by user"),
        (RuntimeError("no event loop"), "no event loop"),
    ],
)
def test_an_interrupt_or_a_crash_outside_a_command(
    runner, monkeypatch, capsys, error, message
) -> None:
    def stop_run(coroutine):
        coroutine.close()
        raise error

    monkeypatch.setattr(runner.asyncio, "run", stop_run)
    monkeypatch.setattr(sys, "argv", ["runner", "summary"])
    with pytest.raises(SystemExit):
        runner.main()
    assert _events(capsys)[-1] == {"type": "error", "message": message}
