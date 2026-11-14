"""The Architecture Visualizer runner, run as the Architecture page runs it.

The vendored archify renderer and Node are real: a map is validated and
rendered for real. Only the model is a stand-in, one that writes the model
file the way an authoring agent would.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from architecture_visualizer.archify import ArchifyUnavailable, authoring, check
from architecture_visualizer.archify import delta as delta_module
from architecture_visualizer.archify.task_delta import (
    BASELINE_HTML,
    BASELINE_SPEC,
    baseline_dir,
)

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "architecture_visualizer_runner.py"
SENTINEL = "__ARCH_VIZ_RESULT__:"

needs_archify = pytest.mark.skipif(
    not check().ok, reason="archify needs Node.js 22+ and the vendored renderer"
)


def _model() -> dict:
    """A model archify accepts at showcase quality: its own web-app example."""
    example = check().archify_root / "examples" / "web-app.architecture.json"
    return json.loads(example.read_text(encoding="utf-8"))


def _sentinel(out: str) -> dict:
    [line] = [x for x in out.splitlines() if x.startswith(SENTINEL)]
    return json.loads(line[len(SENTINEL) :])


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "web").mkdir(parents=True)
    (root / "web" / "app.ts").write_text("fetch('/api/orders')\n", encoding="utf-8")
    (root / "api").mkdir()
    (root / "api" / "main.py").write_text("def orders(): ...\n", encoding="utf-8")
    for args in (
        ["init", "-q"],
        ["config", "user.email", "t@example.test"],
        ["config", "user.name", "t"],
        ["add", "-A"],
        ["commit", "-q", "-m", "base"],
    ):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
    return root


@pytest.fixture
def runner():
    return importlib.import_module("runners.architecture_visualizer_runner")


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch):
    """Stand-ins for the client factory and the session: the session writes
    the model into the spec folder it was given, as the agent would."""
    import agents.session
    import core.client

    seen: dict[str, list] = {"clients": [], "prompts": []}
    state = {"write": True}

    def create_agent_client(**options):
        seen["clients"].append(options)
        return _Client()

    async def run_agent_session(client, prompt, spec_dir, **kwargs):
        seen["prompts"].append((prompt, spec_dir, kwargs))
        if state["write"]:
            (Path(spec_dir) / BASELINE_SPEC).write_text(
                json.dumps(_model()), encoding="utf-8"
            )
        return "complete", "written", {}

    monkeypatch.setattr(core.client, "create_agent_client", create_agent_client)
    monkeypatch.setattr(agents.session, "run_agent_session", run_agent_session)
    seen["state"] = state
    return seen


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _main(runner, monkeypatch, *args: str) -> int:
    monkeypatch.setattr(sys, "argv", ["architecture_visualizer_runner.py", *args])
    return runner.main()


# --- map, then doctor ----------------------------------------------------------


@needs_archify
def test_map_authors_validates_and_renders_the_baseline(
    runner, agent, project, monkeypatch, capsys
) -> None:
    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(project),
        "--model",
        "haiku",
        "--thinking-level",
        "low",
    )

    payload = _sentinel(capsys.readouterr().out)
    assert code == 0, payload
    assert payload["status"] == "success" and payload["action"] == "map"
    assert (payload["components"], payload["connections"]) == (10, 9)
    assert payload["title"] == "Sample Web App"
    assert (baseline_dir(project) / BASELINE_HTML).is_file()

    [client] = agent["clients"]
    assert client["agent_type"] == "architecture_visualizer"
    assert client["project_dir"] == project.resolve()
    [(_prompt, spec_dir, kwargs)] = agent["prompts"]
    assert spec_dir == baseline_dir(project.resolve())
    assert kwargs["phase"].name == "VALIDATION"

    code = _main(
        runner, monkeypatch, "--action", "doctor", "--project-dir", str(project)
    )

    doctor = _sentinel(capsys.readouterr().out)
    assert code == 0
    assert doctor["readiness"]["ok"] is True
    assert doctor["archify"]
    assert doctor["baseline"]["title"] == "Sample Web App"
    assert doctor["baseline"]["components"] == 10
    assert doctor["baseline"]["connections"] == 9
    assert doctor["baseline"]["artifact"].endswith(BASELINE_HTML)


@needs_archify
def test_a_session_that_writes_no_model_fails_the_map(
    runner, agent, project, monkeypatch, capsys
) -> None:
    agent["state"]["write"] = False

    code = _main(runner, monkeypatch, "--project-dir", str(project))

    payload = _sentinel(capsys.readouterr().out)
    assert code == 1
    assert payload["status"] == "error" and payload["action"] == "map"
    assert "components" not in payload


def test_doctor_reports_a_baseline_it_cannot_read(
    runner, project, monkeypatch, capsys
) -> None:
    spec = baseline_dir(project) / BASELINE_SPEC
    spec.parent.mkdir(parents=True)
    spec.write_text("{not json", encoding="utf-8")

    code = _main(
        runner, monkeypatch, "--action", "doctor", "--project-dir", str(project)
    )

    payload = _sentinel(capsys.readouterr().out)
    assert code == 0
    assert payload["baseline"]["path"] == str(spec.resolve())
    assert payload["baseline"]["error"]


# --- delta ---------------------------------------------------------------------


@needs_archify
def test_delta_needs_a_spec_folder(runner, project, monkeypatch, capsys) -> None:
    code = _main(
        runner, monkeypatch, "--action", "delta", "--project-dir", str(project)
    )

    assert code == 1
    assert _sentinel(capsys.readouterr().out) == {
        "status": "error",
        "error": "--spec-dir is required for --action delta",
    }


@needs_archify
def test_delta_without_a_baseline_maps_nothing(
    runner, agent, project, monkeypatch, capsys
) -> None:
    spec_dir = project / ".workpilot" / "specs" / "001-orders"
    spec_dir.mkdir(parents=True)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "delta",
        "--project-dir",
        str(project),
        "--spec-dir",
        str(spec_dir),
        "--changed-files",
        "api/main.py, web/app.ts\n\n",
        "--task-summary",
        "orders endpoint",
    )

    payload = _sentinel(capsys.readouterr().out)
    assert code == 0
    assert payload["action"] == "delta" and payload["status"] == "success"
    assert payload["delta"]["status"] == delta_module.STATUS_NO_BASELINE
    assert agent["prompts"] == []


@needs_archify
def test_delta_passes_the_changed_files_it_was_given(
    runner, project, monkeypatch, capsys
) -> None:
    calls = []

    async def run_task_delta(project_dir, spec_dir, **kwargs):
        calls.append(kwargs)
        return delta_module.DeltaStatus(status=delta_module.STATUS_MAPPED)

    monkeypatch.setattr(runner, "run_task_delta", run_task_delta)

    code = _main(
        runner,
        monkeypatch,
        "--action",
        "delta",
        "--project-dir",
        str(project),
        "--spec-dir",
        str(project / "spec"),
        "--changed-files",
        "api/main.py, web/app.ts\n\n",
        "--force",
    )

    assert code == 0
    assert _sentinel(capsys.readouterr().out)["status"] == "success"
    [call] = calls
    assert call["changed_files"] == ["api/main.py", "web/app.ts"]
    assert call["force"] is True


# --- refusals and failures -------------------------------------------------------


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(tmp_path / "gone")],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 1
    assert "project directory not found" in _sentinel(done.stdout)["error"]


@pytest.mark.parametrize("action", ["map", "delta"])
def test_without_node_map_and_delta_say_what_is_missing(
    runner, project, monkeypatch, capsys, action
) -> None:
    from architecture_visualizer.archify import runtime

    monkeypatch.setattr(runtime, "node_executable", lambda: None)

    code = _main(runner, monkeypatch, "--action", action, "--project-dir", str(project))

    payload = _sentinel(capsys.readouterr().out)
    assert code == 1
    assert payload["action"] == action
    assert payload["error"].startswith("install Node.js")
    assert payload["readiness"]["ok"] is False


def test_doctor_without_node_does_not_run_archify(
    runner, project, monkeypatch, capsys
) -> None:
    from architecture_visualizer.archify import runtime

    monkeypatch.setattr(runtime, "node_executable", lambda: None)

    code = _main(
        runner, monkeypatch, "--action", "doctor", "--project-dir", str(project)
    )

    payload = _sentinel(capsys.readouterr().out)
    assert code == 0
    assert payload["readiness"]["ok"] is False
    assert "archify" not in payload and payload["baseline"] is None


@needs_archify
@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        (KeyboardInterrupt(), {"status": "cancelled"}),
        (RuntimeError("disk full"), {"status": "error", "error": "disk full"}),
    ],
)
def test_an_interrupted_or_failed_map_still_answers(
    runner, project, monkeypatch, capsys, raised, expected
) -> None:
    async def author(**_kwargs):
        raise raised

    monkeypatch.setattr(authoring, "author", author)

    code = _main(runner, monkeypatch, "--project-dir", str(project))

    assert code == 1
    assert _sentinel(capsys.readouterr().out) == expected


@needs_archify
def test_archify_going_missing_mid_run_is_reported(
    runner, project, monkeypatch, capsys
) -> None:
    readiness = check()

    async def author(**_kwargs):
        raise ArchifyUnavailable(readiness)

    monkeypatch.setattr(authoring, "author", author)

    code = _main(runner, monkeypatch, "--project-dir", str(project))

    payload = _sentinel(capsys.readouterr().out)
    assert code == 1
    assert payload["error"].startswith("archify is unavailable")
    assert payload["readiness"] == readiness.to_dict()
