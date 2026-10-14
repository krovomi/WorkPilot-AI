"""Tests for the OpenCode CLI-backed agent client (`opencode run --format json`)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.agent_client import ContentBlockType, MessageRole, OpenCodeCliAgentClient
from core.agent_clients.opencode_cli import (
    OpenCodeCliAuthenticationError,
    OpenCodeCliError,
    build_opencode_run_args,
    opencode_agent_for,
    resolve_opencode_model,
)


class _LineReader:
    def __init__(self, lines: list[str]) -> None:
        self._lines = [f"{line}\n".encode() for line in lines]

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""

    async def read(self) -> bytes:
        remaining = b"".join(self._lines)
        self._lines.clear()
        return remaining


class _StdinWriter:
    def __init__(self) -> None:
        self.data = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _FakeProcess:
    def __init__(
        self,
        stdout_lines: list[str],
        stderr_lines: list[str] | None = None,
        returncode: int | None = 0,
    ) -> None:
        self.stdout = _LineReader(stdout_lines)
        self.stderr = _LineReader(stderr_lines or [])
        self.stdin = _StdinWriter()
        self.returncode = returncode
        self.terminated = False

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = -15 if self.terminated else 0
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.terminated = True


class _ProcessFactory:
    def __init__(self, *processes: _FakeProcess) -> None:
        self.processes = list(processes)
        self.calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    async def __call__(self, *args: str, **kwargs: object) -> _FakeProcess:
        self.calls.append((args, kwargs))
        return self.processes.pop(0)


SESSION = "ses_0123456789abcdefghij"


def _event(event_type: str, **values: object) -> str:
    return json.dumps(
        {"type": event_type, "timestamp": 1, "sessionID": SESSION, **values}
    )


def _step_finish(fresh: int, read: int, write: int, output: int) -> str:
    return _event(
        "step_finish",
        part={
            "type": "step-finish",
            "reason": "stop",
            "cost": 0.01,
            "tokens": {
                "input": fresh,
                "output": output,
                "reasoning": 5,
                "cache": {"read": read, "write": write},
            },
        },
    )


def _client(
    tmp_path: Path, factory: _ProcessFactory, **kwargs
) -> OpenCodeCliAgentClient:
    return OpenCodeCliAgentClient(
        project_dir=str(tmp_path),
        executable="opencode",
        process_factory=factory,
        **kwargs,
    )


async def _collect(client: OpenCodeCliAgentClient, prompt: str = "do it"):
    await client.query(prompt)
    return [message async for message in client.receive_response()]


# --- argument building ------------------------------------------------------


def test_new_turn_builds_a_shell_free_command_without_the_prompt() -> None:
    args = build_opencode_run_args(
        executable="opencode",
        model="anthropic/claude-sonnet-4-5",
        session_id=None,
        agent="build",
    )

    assert args == [
        "opencode",
        "run",
        "--format",
        "json",
        "--agent",
        "build",
        "--auto",
        "--model",
        "anthropic/claude-sonnet-4-5",
    ]


def test_resume_targets_the_exact_session() -> None:
    args = build_opencode_run_args(
        executable="opencode", model=None, session_id=SESSION, agent="build"
    )

    assert args[args.index("--session") + 1] == SESSION
    assert "--model" not in args


def test_plan_agent_never_gets_auto_approval() -> None:
    args = build_opencode_run_args(
        executable="opencode", model=None, session_id=None, agent="plan"
    )

    assert args[args.index("--agent") + 1] == "plan"
    assert "--auto" not in args


@pytest.mark.parametrize("bad", ["x&whoami", "a b", 'm"odel', "%PATH%"])
def test_unsafe_option_values_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        build_opencode_run_args(
            executable="opencode", model=bad, session_id=None, agent="build"
        )


def test_read_only_types_map_to_the_plan_agent() -> None:
    assert opencode_agent_for("pr_reviewer") == "plan"
    assert opencode_agent_for("spec_critic") == "plan"
    assert opencode_agent_for("coder") == "build"
    assert opencode_agent_for("qa_fixer") == "build"
    # An unregistered type stays permissive, as the executor keeps it.
    assert opencode_agent_for("not-a-type") == "build"


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (None, None),
        ("default", None),
        ("openai/gpt-5", "openai/gpt-5"),
        ("claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"),
        ("gemini-2.5-pro", "google/gemini-2.5-pro"),
        ("some-local-thing", None),
    ],
)
def test_models_are_qualified_as_provider_slash_model(given, expected) -> None:
    assert resolve_opencode_model(given) == expected


# --- a turn -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_turn_sends_prompt_on_stdin_and_parses_events(tmp_path: Path) -> None:
    process = _FakeProcess(
        [
            _event("step_start", part={"type": "step-start"}),
            _event(
                "tool_use",
                part={
                    "type": "tool",
                    "tool": "bash",
                    "callID": "call_1",
                    "state": {
                        "status": "completed",
                        "input": {"command": "ls"},
                        "output": "README.md",
                    },
                },
            ),
            _step_finish(fresh=100, read=900, write=50, output=20),
            _event("text", part={"type": "text", "text": "Done."}),
            _step_finish(fresh=40, read=1100, write=0, output=10),
            "not json at all",
        ]
    )
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, model="openai/gpt-5", system_prompt="SYS")

    messages = await _collect(client, "fix $(unsafe) & stuff")

    args, kwargs = factory.calls[0]
    assert "fix $(unsafe) & stuff" not in " ".join(args)
    assert str(tmp_path) not in args
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["env"]["PWD"] == str(tmp_path)
    stdin = process.stdin.data.decode()
    assert stdin.startswith("SYS")
    assert stdin.endswith("fix $(unsafe) & stuff")
    assert process.stdin.closed

    tool_use = messages[0].content[0]
    assert tool_use.type == ContentBlockType.TOOL_USE
    assert tool_use.tool_name == "bash"
    assert tool_use.tool_input == {"command": "ls"}
    tool_result = messages[1].content[0]
    assert tool_result.type == ContentBlockType.TOOL_RESULT
    assert tool_result.result_content == "README.md"
    assert not tool_result.is_error
    assert messages[-1].role == MessageRole.ASSISTANT
    assert messages[-1].content[0].text == "Done."

    assert client.last_session_id == SESSION
    assert client.resumes_native_session()
    # The latest step's prompt: non-cached input + cache read + cache write.
    assert client.last_context_tokens == 40 + 1100 + 0
    assert client.context_window_tokens is None
    assert client.context_usage_source == "reported"
    assert client.last_usage == {
        "input_tokens": 1050 + 1140,
        "output_tokens": 30,
        "reasoning_tokens": 10,
        "cache_read_input_tokens": 2000,
        "cache_creation_input_tokens": 50,
    }


@pytest.mark.asyncio
async def test_second_turn_continues_the_captured_session(tmp_path: Path) -> None:
    first = _FakeProcess([_event("text", part={"text": "one"})])
    second = _FakeProcess([_event("text", part={"text": "two"})])
    factory = _ProcessFactory(first, second)
    client = _client(tmp_path, factory, system_prompt="SYS")

    await _collect(client, "first")
    await _collect(client, "second")

    second_args = factory.calls[1][0]
    assert second_args[second_args.index("--session") + 1] == SESSION
    # A continued session already holds the system prompt.
    assert second.stdin.data.decode() == "second"


@pytest.mark.asyncio
async def test_constructed_with_a_session_resumes_natively(tmp_path: Path) -> None:
    process = _FakeProcess([_event("text", part={"text": "ok"})])
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, session_id=SESSION)

    assert client.resumes_native_session()
    await _collect(client)
    args = factory.calls[0][0]
    assert args[args.index("--session") + 1] == SESSION


@pytest.mark.asyncio
async def test_read_only_agent_type_runs_plan(tmp_path: Path) -> None:
    process = _FakeProcess([_event("text", part={"text": "looks fine"})])
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, agent_type="pr_reviewer")

    await _collect(client)

    args = factory.calls[0][0]
    assert args[args.index("--agent") + 1] == "plan"
    assert "--auto" not in args


@pytest.mark.asyncio
async def test_no_token_event_reports_estimated(tmp_path: Path) -> None:
    factory = _ProcessFactory(_FakeProcess([_event("text", part={"text": "hi"})]))
    client = _client(tmp_path, factory)

    await _collect(client)

    assert client.last_context_tokens is None
    assert client.context_usage_source == "estimated"


@pytest.mark.asyncio
async def test_error_event_is_redacted(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [
                _event(
                    "error",
                    error={
                        "name": "APIError",
                        "data": {
                            "message": "boom Bearer abc.def.ghi sk-1234567890abcdef"
                        },
                    },
                )
            ],
            returncode=1,
        )
    )
    client = _client(tmp_path, factory)

    with pytest.raises(OpenCodeCliError) as excinfo:
        await _collect(client)

    text = str(excinfo.value)
    assert "abc.def.ghi" not in text
    assert "sk-1234567890abcdef" not in text
    assert "Bearer [REDACTED]" in text


@pytest.mark.asyncio
async def test_authentication_errors_name_the_login_command(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [_event("error", error={"message": "401 Unauthorized: invalid api key"})],
            returncode=1,
        )
    )
    client = _client(tmp_path, factory)

    with pytest.raises(OpenCodeCliAuthenticationError, match="opencode auth login"):
        await _collect(client)


@pytest.mark.asyncio
async def test_nonzero_exit_reports_redacted_stderr(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess([], stderr_lines=["crashed token=supersecret"], returncode=2)
    )
    client = _client(tmp_path, factory)

    with pytest.raises(OpenCodeCliError) as excinfo:
        await _collect(client)

    assert "supersecret" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_rejected_model_retries_once_on_the_cli_default(tmp_path: Path) -> None:
    rejected = _FakeProcess(
        [_event("error", error={"message": "Model not found: openai/gpt-404"})],
        returncode=1,
    )
    retried = _FakeProcess([_event("text", part={"text": "ok"})])
    factory = _ProcessFactory(rejected, retried)
    client = _client(tmp_path, factory, model="openai/gpt-404")

    messages = await _collect(client)

    assert messages[-1].content[0].text == "ok"
    assert "--model" in factory.calls[0][0]
    assert "--model" not in factory.calls[1][0]


@pytest.mark.asyncio
async def test_missing_executable_is_a_clear_error(tmp_path: Path, monkeypatch) -> None:
    from core.agent_clients import opencode_cli

    monkeypatch.setattr(opencode_cli, "find_executable", lambda name: None)
    client = OpenCodeCliAgentClient(
        project_dir=str(tmp_path), process_factory=_ProcessFactory()
    )

    with pytest.raises(OpenCodeCliError, match="not installed"):
        await _collect(client)


def test_contract_attributes_and_identity(tmp_path: Path) -> None:
    client = _client(tmp_path, _ProcessFactory())

    assert client.provider_name() == "opencode"
    assert client.supports_subagents() is False
    assert client.resumes_native_session() is False
    assert client.last_usage is None
    assert client.last_session_id is None
    assert client.last_context_tokens is None
    assert client.context_window_tokens is None
    assert client.context_usage_source in {"reported", "estimated"}


# --- factory ----------------------------------------------------------------


def test_create_agent_client_routes_opencode(tmp_path: Path) -> None:
    from core.client import create_agent_client

    client = create_agent_client(
        project_dir=tmp_path,
        spec_dir=tmp_path,
        model="anthropic/claude-sonnet-4-5",
        provider="opencode",
        resume=SESSION,
    )

    assert isinstance(client, OpenCodeCliAgentClient)
    assert client.model == "anthropic/claude-sonnet-4-5"
    assert client.last_session_id == SESSION
    assert client.resumes_native_session()


def test_opencode_never_asks_for_the_claude_oauth_token() -> None:
    from core.auth import provider_requires_claude_oauth

    assert provider_requires_claude_oauth("opencode") is False


def test_opencode_phase_default_is_the_cli_default(tmp_path: Path) -> None:
    from phase_config import get_phase_model

    assert get_phase_model(tmp_path, "coding", cli_provider="opencode") == "default"
