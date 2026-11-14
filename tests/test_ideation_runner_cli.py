"""The Ideation runner, run as the Ideation page runs it.

The whole orchestration is real: project index, context, graph hints, one
agent per idea type in parallel, validation and the merged ideation file.
The agents are a stand-in client that writes the file the prompt asks for,
as the ideation agent does with its Write tool.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "ideation_runner.py"


def _process(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = _process("--project", str(tmp_path / "gone"))

    assert done.returncode == 1
    assert "Project directory does not exist" in done.stdout


def test_an_unknown_idea_type_is_refused(tmp_path: Path) -> None:
    done = _process("--project", str(tmp_path), "--types", "code_quality, moonshots")

    assert done.returncode == 1
    assert "Invalid ideation types: ['moonshots']" in done.stdout


class _Client:
    """Writes the ideas file named in the prompt; or writes nothing."""

    def __init__(self, behaviour: dict, options: dict):
        self._behaviour = behaviour
        self.options = options

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, prompt: str) -> None:
        self._behaviour["prompts"].append(prompt)
        if self._behaviour.get("raise"):
            raise self._behaviour["raise"]
        match = re.search(r"\*\*Output File\*\*: (\S+)", prompt)
        if match and self._behaviour.get("write", True):
            out = Path(match.group(1))
            kind = out.name.removesuffix("_ideas.json")
            out.write_text(
                json.dumps(
                    {
                        kind: [
                            {
                                "id": f"{kind}-1",
                                "type": kind,
                                "title": f"First {kind} idea",
                                "description": "Grounded in the project.",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

    async def receive_response(self):
        if False:
            yield None


@pytest.fixture
def agents(monkeypatch):
    import ideation.generator

    behaviour: dict = {"prompts": [], "clients": []}

    def create_agent_client(**options):
        behaviour["clients"].append(options)
        return _Client(behaviour, options)

    monkeypatch.setattr(ideation.generator, "create_agent_client", create_agent_client)
    return behaviour


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("ideation_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"react": "19"}}), encoding="utf-8"
    )
    (root / "src").mkdir()
    (root / "src" / "App.tsx").write_text(
        "export const App = () => null;\n", encoding="utf-8"
    )
    return root


def _main(runner, monkeypatch, *args: str) -> int:
    monkeypatch.setattr(sys, "argv", ["ideation_runner.py", *args])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    return stop.value.code


def test_two_idea_types_are_generated_and_merged(
    runner, agents, project, tmp_path, monkeypatch
) -> None:
    out = tmp_path / "ideation"

    code = _main(
        runner,
        monkeypatch,
        "--project",
        str(project),
        "--output",
        str(out),
        "--types",
        "code_quality,security_hardening",
        "--max-ideas",
        "3",
        "--model",
        "haiku",
        "--thinking-level",
        "low",
        "--no-roadmap",
        "--no-kanban",
    )

    assert code == 0
    assert (out / "code_quality_ideas.json").is_file()
    assert (out / "security_hardening_ideas.json").is_file()
    context = json.loads((out / "ideation_context.json").read_text(encoding="utf-8"))
    assert context["config"]["enabled_types"] == ["code_quality", "security_hardening"]
    assert context["config"]["max_ideas_per_type"] == 3
    assert context["config"]["include_roadmap_context"] is False
    assert {c["agent_type"] for c in agents["clients"]} == {"ideation"}
    assert all("**Max Ideas**: 3" in p for p in agents["prompts"])


def test_ideas_that_never_get_written_fail_the_run(
    runner, agents, project, tmp_path, monkeypatch
) -> None:
    agents["write"] = False

    code = _main(
        runner,
        monkeypatch,
        "--project",
        str(project),
        "--output",
        str(tmp_path / "ideation"),
        "--types",
        "code_quality",
    )

    assert code == 1


def test_an_interrupted_run_says_so(
    runner, agents, project, tmp_path, monkeypatch, capsys
) -> None:
    from ideation import IdeationOrchestrator

    async def interrupted(self):
        raise KeyboardInterrupt

    monkeypatch.setattr(IdeationOrchestrator, "run", interrupted)

    code = _main(runner, monkeypatch, "--project", str(project))

    assert code == 1
    assert "Ideation generation interrupted." in capsys.readouterr().out


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
    spec = importlib.util.spec_from_file_location("ideation_env_t", RUNNER)
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    assert loaded == [env_file]
