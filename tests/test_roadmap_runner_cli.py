"""The roadmap runner, run as the Roadmap page runs it.

The orchestration is real: the project index (the project's own, or the
analyzer run for real), graph hints, discovery, features and their checks.
The agents are a stand-in client that writes the file its prompt names, as
the roadmap agents do with their Write tool.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "roadmap_runner.py"

DISCOVERY = {
    "project_name": "shop",
    "target_audience": {"primary": "small shops"},
    "product_vision": {"one_liner": "Sell online in a day"},
}
ROADMAP = {
    "vision": "Sell online in a day",
    "target_audience": {"primary": "small shops"},
    "phases": [{"id": "phase-1", "name": "Launch"}],
    "features": [
        {"id": "f-1", "title": "Card payments", "priority": "must"},
        {"id": "f-2", "title": "Gift cards", "priority": "could"},
        {"id": "f-3", "title": "Stock alerts", "priority": "should"},
    ],
}


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(tmp_path / "gone")],
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
    assert "Error: Project directory does not exist" in done.stdout


class _Client:
    """Writes the file named in the prompt; or writes nothing."""

    def __init__(self, behaviour: dict):
        self._behaviour = behaviour

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, prompt: str) -> None:
        self._behaviour["prompts"].append(prompt)
        match = re.search(r"\*\*Output File\*\*: (\S+)", prompt)
        if match and self._behaviour.get("write", True):
            out = Path(match.group(1))
            payload = DISCOVERY if out.name == "roadmap_discovery.json" else ROADMAP
            out.write_text(json.dumps(payload), encoding="utf-8")

    async def receive_response(self):
        if False:
            yield None


@pytest.fixture
def agents(monkeypatch):
    import runners.roadmap.orchestrator as orchestrator

    behaviour: dict = {"prompts": [], "clients": []}

    def create_agent_client(project_dir, output_dir, model, **options):
        behaviour["clients"].append({"model": model, **options})
        return _Client(behaviour)

    monkeypatch.setattr(orchestrator, "create_agent_client", create_agent_client)
    return behaviour


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("roadmap_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"react": "19"}}), encoding="utf-8"
    )
    (root / "src" / "App.tsx").write_text("export const App = () => null;\n", "utf-8")
    return root


def _main(runner, monkeypatch, *args: str) -> int:
    monkeypatch.setattr(sys, "argv", ["roadmap_runner.py", *args])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    return stop.value.code


def test_the_projects_own_index_feeds_a_roadmap(
    runner, agents, project, tmp_path, monkeypatch
) -> None:
    index = {"project_type": "single", "services": {"web": {"language": "TypeScript"}}}
    (project / ".workpilot").mkdir()
    (project / ".workpilot" / "project_index.json").write_text(
        json.dumps(index), encoding="utf-8"
    )
    out = tmp_path / "roadmap"

    code = _main(
        runner,
        monkeypatch,
        "--project",
        str(project),
        "--output",
        str(out),
        "--model",
        "haiku",
        "--thinking-level",
        "low",
    )

    assert code == 0
    # The project's index, not one found beside the backend.
    assert json.loads((out / "project_index.json").read_text("utf-8")) == index
    assert json.loads((out / "roadmap.json").read_text("utf-8"))["features"]
    assert {c["model"] for c in agents["clients"]} == {"haiku"}
    assert len(agents["prompts"]) == 2


def test_without_an_index_the_analyzer_builds_one(
    runner, agents, project, monkeypatch, capsys
) -> None:
    code = _main(runner, monkeypatch, "--project", str(project), "--refresh")

    out = project / ".workpilot" / "roadmap"
    assert code == 0, capsys.readouterr().out
    assert (out / "project_index.json").is_file()
    assert (out / "roadmap.json").is_file()
    assert "ROADMAP GENERATED" in capsys.readouterr().out


def test_agents_that_write_nothing_fail_the_run(
    runner, agents, project, tmp_path, monkeypatch, capsys
) -> None:
    agents["write"] = False
    out = tmp_path / "roadmap"
    out.mkdir()
    (out / "project_index.json").write_text("{}", encoding="utf-8")

    code = _main(runner, monkeypatch, "--project", str(project), "--output", str(out))

    assert code == 1
    assert "Discovery failed" in capsys.readouterr().out
    assert not (out / "roadmap.json").exists()


def test_an_interrupted_run_says_so(runner, project, monkeypatch, capsys) -> None:
    from runners.roadmap import RoadmapOrchestrator

    async def interrupted(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(RoadmapOrchestrator, "run", interrupted)

    assert _main(runner, monkeypatch, "--project", str(project)) == 1
    assert "Roadmap generation interrupted." in capsys.readouterr().out


def test_the_backend_env_file_is_loaded_when_there_is_one(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    import cli.utils

    env_file = BACKEND.parent.parent / ".env-files" / ".env"
    loaded: list[Path] = []
    real_exists = Path.exists
    monkeypatch.setattr(
        Path, "exists", lambda self: self == env_file or real_exists(self)
    )
    monkeypatch.setattr(cli.utils, "import_dotenv", lambda: loaded.append)
    spec = importlib.util.spec_from_file_location("roadmap_env_t", RUNNER)
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    assert loaded == [env_file]
