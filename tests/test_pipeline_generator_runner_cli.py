"""The Pipeline Generator runner, as the desktop app starts it.

The stack detection, the files and the CLI run for real; the one model session
is a stand-in that answers with marked pipelines.
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
RUNNER = BACKEND / "runners" / "pipeline_generator_runner.py"
MARKER = "__PIPELINE_GENERATOR_RESULT__:"
GITHUB = "name: ci\non: push\njobs: {}\n"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"react": "19.0.0"}}),
        encoding="utf-8",
    )
    (root / "Dockerfile").write_text("FROM node:22\n", encoding="utf-8")
    return root


def _run(project: Path, *args: str) -> tuple[int, list[str]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    return done.returncode, done.stdout.splitlines()


def test_saved_pipelines_are_served_without_a_model(project: Path) -> None:
    saved = project / ".workpilot" / "pipelines"
    saved.mkdir(parents=True)
    (saved / "pipeline_github.yml").write_text(GITHUB, encoding="utf-8")
    code, lines = _run(project, "--platforms", "GitHub", "--write-to-project")
    assert code == 0
    [line] = [ln for ln in lines if ln.startswith(MARKER)]
    out = json.loads(line[len(MARKER) :])
    assert out["pipelines"] == {"github": GITHUB}
    assert out["platforms_generated"] == ["github"]
    assert out["stack"]["has_docker"] is True
    assert (project / ".github" / "workflows" / "ci.yml").read_text(
        encoding="utf-8"
    ) == GITHUB
    assert "🐳 Dockerfile detected" in lines
    assert lines[-1] == "✅ Done! Generated 1 pipeline(s)."


def test_an_unknown_platform_is_refused(project: Path) -> None:
    code, lines = _run(project, "--platforms", "github,jenkins")
    assert code == 1
    assert lines == [
        "Error: Invalid platforms: ['jenkins']",
        "Valid platforms: ['github', 'gitlab', 'circleci', 'azure', 'bitbucket']",
    ]


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1 and lines[0].startswith("Error: Project directory does not exist:")


# --- the model session, in-process -------------------------------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("pipeline_gen_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StandInClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _answer(runner, monkeypatch, text: str | Exception) -> list[dict]:
    import agents.session

    clients: list[dict] = []
    prompts: list[str] = []

    def create_client(**options):
        clients.append(options)
        return StandInClient()

    async def run_agent_session(_client, prompt, _spec_dir):
        prompts.append(prompt)
        if isinstance(text, Exception):
            raise text
        return "complete", text, {}

    monkeypatch.setattr(runner, "create_client", create_client)
    monkeypatch.setattr(agents.session, "run_agent_session", run_agent_session)
    return clients, prompts


def test_the_model_answer_is_split_by_platform(
    runner, monkeypatch, project: Path
) -> None:
    answer = (
        "Here you go.\n"
        f"__PIPELINE_START__:github\n```yaml\n{GITHUB}```\n__PIPELINE_END__:github\n"
        "__PIPELINE_START__:gitlab\nstages: [test]\n__PIPELINE_END__:gitlab\n"
    )
    clients, prompts = _answer(runner, monkeypatch, answer)
    out = project / ".workpilot" / "pipelines"
    result = asyncio.run(
        runner.generate_pipelines(project, ["github", "gitlab", "circleci"], out)
    )
    assert result["status"] == "success"
    assert result["pipelines"] == {
        "github": GITHUB.rstrip(),
        "gitlab": "stages: [test]",
    }
    assert clients[0]["project_dir"] == project
    assert "CircleCI" in prompts[0] and '"has_docker": true' in prompts[0]

    saved = runner.save_pipelines({**result["pipelines"], "azure": ""}, out, project)
    assert sorted(saved) == ["github", "gitlab"]
    assert not (project / ".gitlab-ci.yml").exists()


def test_a_failed_session_is_an_error_result(runner, monkeypatch, project) -> None:
    _answer(runner, monkeypatch, RuntimeError("rate limited"))
    result = asyncio.run(
        runner.generate_pipelines(project, ["github"], project / "out", refresh=True)
    )
    assert result["status"] == "error" and result["error"] == "rate limited"


@pytest.mark.parametrize(
    ("outcome", "last"),
    [
        ({"status": "error", "error": "rate limited"}, "❌ Pipeline generation failed"),
        (KeyboardInterrupt(), "Pipeline generation interrupted."),
    ],
)
def test_main_stops_with_one(runner, monkeypatch, capsys, project, outcome, last):
    async def generate(**_kwargs):
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(runner, "generate_pipelines", generate)
    monkeypatch.setattr(sys, "argv", ["r", "--project", str(project)])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    assert last in capsys.readouterr().out


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
    spec = importlib.util.spec_from_file_location("pipeline_gen_env_test", RUNNER)
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    assert loaded == [env_file]
