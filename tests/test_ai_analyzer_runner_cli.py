"""The AI-enhanced analyzer, run from the command line as its docstring says.

The orchestration, analyzers, cache, cost estimate and summary are real; the
Claude client the canonical factory returns is a stand-in, answering as the
SDK streams an answer.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "ai_analyzer_runner.py"
INDEX = {
    "project_type": "single",
    "services": {
        "api": {"language": "Python", "framework": "FastAPI", "path": "api"},
    },
}


def test_without_the_programmatic_analysis_it_says_what_to_run(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(tmp_path)],
        cwd=BACKEND,
        # As the app starts a runner (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )

    assert done.returncode == 1
    assert "Programmatic analysis not found" in done.stdout
    assert f"Run: python analyzer.py --project-dir {tmp_path} --index" in done.stdout


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    monkeypatch.syspath_prepend(str(BACKEND / "runners"))
    spec = importlib.util.spec_from_file_location("ai_analyzer_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TextBlock:
    def __init__(self, text: str):
        self.text = text


class AssistantMessage:
    def __init__(self, text: str):
        self.content = [TextBlock(text)]


class ResultMessage:
    usage = {"input_tokens": 10, "output_tokens": 5}
    total_cost_usd = 0.001


@pytest.fixture
def claude(monkeypatch):
    import core.auth
    import core.client

    seen: dict = {"prompts": [], "options": [], "fail": set()}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def query(self, prompt: str) -> None:
            seen["prompts"].append(prompt)
            self._prompt = prompt

        async def receive_response(self):
            if any(word in self._prompt for word in seen["fail"]):
                raise RuntimeError("stream cut")
            yield AssistantMessage('Here: {"score": 80, "findings": []}')
            yield ResultMessage()

    def create_client(**options):
        seen["options"].append(options)
        return Client()

    monkeypatch.setattr(core.client, "create_client", create_client)
    monkeypatch.setattr(core.auth, "require_auth_token", lambda: "token")
    return seen


def _main(runner, monkeypatch, project: Path, *args: str) -> int:
    monkeypatch.setattr(
        sys, "argv", ["ai_analyzer_runner.py", "--project-dir", str(project), *args]
    )
    return runner.main()


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "api").mkdir()
    (tmp_path / "api" / "main.py").write_text("app = None\n", encoding="utf-8")
    (tmp_path / "comprehensive_analysis.json").write_text(
        json.dumps(INDEX), encoding="utf-8"
    )
    return tmp_path


def test_the_chosen_analyzers_run_and_are_cached(
    runner, claude, project, monkeypatch, capsys
) -> None:
    code = _main(
        runner, monkeypatch, project, "--analyzers", "security", "performance", "moon"
    )

    out = capsys.readouterr().out
    assert code == 0
    assert "Unknown analyzer: moon, skipping..." in out
    assert "Overall Score: 80/100" in out
    assert len(claude["prompts"]) == 2
    assert {o["agent_type"] for o in claude["options"]} == {"analyzer"}

    # A second run answers from the cache, without the model.
    assert _main(runner, monkeypatch, project) == 0
    assert len(claude["prompts"]) == 2


def test_an_analyzer_that_fails_is_reported_and_left_out_of_the_score(
    runner, claude, project, monkeypatch, capsys
) -> None:
    claude["fail"] = {"security"}

    code = _main(
        runner,
        monkeypatch,
        project,
        "--skip-cache",
        "--analyzers",
        "security",
        "code_quality",
    )

    out = capsys.readouterr().out
    assert code == 0
    assert "✗ Error: stream cut" in out
    assert "Overall Score: 80/100" in out


def test_without_the_analyzer_package_it_says_so(
    runner, project, monkeypatch, capsys
) -> None:
    monkeypatch.setitem(sys.modules, "ai_analyzer", None)

    assert _main(runner, monkeypatch, project) == 1
    assert "Failed to import AI analyzer" in capsys.readouterr().out
