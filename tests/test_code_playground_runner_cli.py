"""The Code Playground runner, as the Code Playground view starts it.

Argument errors run on the real process. The model call goes to a stand-in
client that answers with the message shapes the SDK streams; everything
around it (prompts, the answer's parsing, the result marker the view reads)
is the runner's own.
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
RUNNER = BACKEND / "runners" / "code_playground_runner.py"
RESULT = "__PLAYGROUND_RESULT__:"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def test_a_missing_project_directory_is_refused(tmp_path: Path) -> None:
    done = _run(
        "--project-dir",
        str(tmp_path / "gone"),
        "--idea",
        "a counter",
        "--playground-type",
        "html",
        "--sandbox-type",
        "iframe",
    )
    assert done.returncode == 1
    assert "Project directory does not exist" in done.stderr


def test_an_unknown_playground_type_is_refused(tmp_path: Path) -> None:
    done = _run(
        "--project-dir",
        str(tmp_path),
        "--idea",
        "a counter",
        "--playground-type",
        "cobol",
        "--sandbox-type",
        "iframe",
    )
    assert done.returncode == 2
    assert "invalid choice: 'cobol'" in done.stderr


# --- the stand-in model ------------------------------------------------------


class TextBlock:
    def __init__(self, text: str):
        self.text = text


class ToolUseBlock:
    def __init__(self, name: str):
        self.name = name


class AssistantMessage:
    def __init__(self, *content):
        self.content = list(content)


class ResultMessage:
    pass


class StandInClient:
    def __init__(self, answer, options):
        self._answer = answer
        self.options = options
        self.prompts: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        for message in self._answer:
            if isinstance(message, BaseException):
                raise message
            yield message


@pytest.fixture
def runner_module(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("code_playground_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch):
    """Install a stand-in answer; returns the clients the runner created."""
    import core.simple_client

    clients: list[StandInClient] = []
    state = {"answer": []}

    def create_simple_client(**options):
        client = StandInClient(state["answer"], options)
        clients.append(client)
        return client

    monkeypatch.setattr(
        core.simple_client, "create_simple_client", create_simple_client
    )

    def answer(*messages):
        state["answer"] = list(messages)
        return clients

    return answer


def _main(module, monkeypatch, project: Path, *extra: str) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "code_playground_runner.py",
            "--project-dir",
            str(project),
            "--idea",
            "a counter with a reset button",
            *extra,
        ],
    )
    asyncio.run(module.main())


def _result(out: str) -> dict:
    [line] = [x for x in out.splitlines() if x.startswith(RESULT)]
    return json.loads(line[len(RESULT) :])


def test_a_json_answer_becomes_the_playground(
    runner_module, model, tmp_path, monkeypatch, capsys
) -> None:
    answer = {
        "html": "<button id='c'>0</button>",
        "javascript": "let n = 0;",
        "files": [
            {"path": "index.html", "content": "<button>0</button>"},
            {"path": "app.js", "content": "x", "size": 99},
        ],
    }
    clients = model(
        AssistantMessage(
            TextBlock("Here it is:\n```json\n"),
            ToolUseBlock("Read"),
            TextBlock(json.dumps(answer) + "\n```"),
        ),
        ResultMessage(),
    )

    _main(
        runner_module,
        monkeypatch,
        tmp_path,
        "--playground-type",
        "react",
        "--sandbox-type",
        "webworker",
        "--model",
        "opus",
        "--thinking-level",
        "high",
    )

    out = capsys.readouterr().out
    result = _result(out)
    assert result["html"] == answer["html"]
    assert result["css"] == "" and result["integrationNotes"] == ""
    assert result["playgroundType"] == "react"
    assert result["sandboxType"] == "webworker"
    # A size is computed when the model left it out, and kept when it gave one.
    assert [f["size"] for f in result["files"]] == [18, 99]
    assert '__TOOL_START__:{"tool": "Read"}' in out

    [client] = clients
    assert client.options["agent_type"] == "code_playground"
    assert client.options["max_turns"] == 5
    assert client.options["cwd"] == tmp_path
    assert "For React playgrounds" in client.options["system_prompt"]
    assert "Web Worker with no DOM access" in client.options["system_prompt"]
    assert "a counter with a reset button" in client.prompts[0]


def test_without_a_model_it_uses_the_users_sonnet(
    runner_module, model, tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "my-sonnet")
    clients = model(AssistantMessage(TextBlock('{"html": "<p>hi</p>"}')))

    _main(
        runner_module,
        monkeypatch,
        tmp_path,
        "--playground-type",
        "html",
        "--sandbox-type",
        "iframe",
    )

    [client] = clients
    assert client.options["model"] == "my-sonnet"
    assert _result(capsys.readouterr().out)["html"] == "<p>hi</p>"


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        ("<h1>Just HTML</h1>", "No JSON found in response"),
        ('Almost: {"html": "<p>", oops}', "JSON parsing failed"),
        ('Never closed: {"html": {"x": 1}', "JSON parsing failed"),
    ],
)
def test_an_answer_that_is_not_json_becomes_a_plain_page(
    runner_module, model, tmp_path, monkeypatch, capsys, answer, reason
) -> None:
    model(AssistantMessage(TextBlock(answer)))

    _main(
        runner_module,
        monkeypatch,
        tmp_path,
        "--playground-type",
        "vanilla-js",
        "--sandbox-type",
        "docker",
    )

    result = _result(capsys.readouterr().out)
    assert result["html"] == answer
    assert result["files"] == [
        {"path": "index.html", "content": answer, "size": len(answer)}
    ]
    assert reason in result["integrationNotes"]
    assert result["sandboxType"] == "docker"


def test_a_failed_session_ends_with_an_error(
    runner_module, model, tmp_path, monkeypatch, capsys
) -> None:
    model(RuntimeError("session dropped"))

    with pytest.raises(SystemExit) as stop:
        _main(
            runner_module,
            monkeypatch,
            tmp_path,
            "--playground-type",
            "python",
            "--sandbox-type",
            "iframe",
        )

    assert stop.value.code == 1
    err = capsys.readouterr().err
    assert "Error generating playground: session dropped" in err
    assert "Fatal error: session dropped" in err


def test_a_cancelled_run_exits_130(
    runner_module, model, tmp_path, monkeypatch, capsys
) -> None:
    model(KeyboardInterrupt())

    with pytest.raises(SystemExit) as stop:
        _main(
            runner_module,
            monkeypatch,
            tmp_path,
            "--playground-type",
            "node",
            "--sandbox-type",
            "iframe",
        )

    assert stop.value.code == 130
    assert "cancelled by user" in capsys.readouterr().out


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
    spec = importlib.util.spec_from_file_location("code_playground_env_t", RUNNER)
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    assert loaded == [env_file]
