"""Tests for the Codex CLI-backed OpenAI agent client."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.agent_client import ContentBlockType, MessageRole
from core.codex_cli_client import (
    CodexCliAgentClient,
    CodexCliAuthenticationError,
    CodexCliError,
    build_codex_exec_args,
)
from core.oneshot import _build_client, oneshot_completion


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

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


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
    def __init__(self, process: _FakeProcess) -> None:
        self.process = process
        self.calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    async def __call__(self, *args: str, **kwargs: object) -> _FakeProcess:
        self.calls.append((args, kwargs))
        return self.process


def _event(event_type: str, **values: object) -> str:
    return json.dumps({"type": event_type, **values})


def test_new_turn_uses_safe_workspace_write_arguments(tmp_path: Path) -> None:
    args = build_codex_exec_args(
        executable="codex",
        project_dir=tmp_path,
        model="gpt-5.6-sol",
        reasoning_effort="high",
        prompt="fix $(unsafe)",
        thread_id=None,
    )

    assert args == [
        "codex",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--model",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "-",
    ]
    assert "fix $(unsafe)" not in args


def test_project_path_never_enters_windows_launcher_arguments() -> None:
    project_dir = Path(r"C:\repo&whoami")

    args = build_codex_exec_args(
        executable="codex.cmd",
        project_dir=project_dir,
        model=None,
        reasoning_effort=None,
        prompt="work",
        thread_id=None,
    )

    assert str(project_dir) not in args
    assert "--cd" not in args


def test_resume_targets_exact_thread_id(tmp_path: Path) -> None:
    args = build_codex_exec_args(
        executable="codex",
        project_dir=tmp_path,
        model=None,
        reasoning_effort=None,
        prompt="continue",
        thread_id="thread-123",
    )

    assert args == [
        "codex",
        "exec",
        "resume",
        "thread-123",
        "--json",
        "-",
    ]


@pytest.mark.asyncio
async def test_stream_translates_final_message_usage_and_thread(tmp_path: Path) -> None:
    process = _FakeProcess(
        [
            _event("thread.started", thread_id="thread-123"),
            _event(
                "item.completed",
                item={"id": "i1", "type": "agent_message", "text": "done"},
            ),
            _event(
                "turn.completed",
                usage={
                    "input_tokens": 10,
                    "cached_input_tokens": 2,
                    "output_tokens": 3,
                    "reasoning_output_tokens": 1,
                },
            ),
        ]
    )
    factory = _ProcessFactory(process)
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=factory,
    )
    await client.query("work")

    messages = [message async for message in client.receive_response()]

    assert messages[-1].role is MessageRole.ASSISTANT
    assert messages[-1].content[0].type is ContentBlockType.TEXT
    assert messages[-1].content[0].text == "done"
    assert client.thread_id == "thread-123"
    assert client.last_session_id == "thread-123"
    assert client.last_usage == {
        "input_tokens": 10,
        "cached_input_tokens": 2,
        "output_tokens": 3,
        "reasoning_output_tokens": 1,
    }
    assert process.stdin.data == b"work"


@pytest.mark.asyncio
@pytest.mark.parametrize("event_type", ["turn.failed", "error"])
async def test_terminal_error_event_is_reported(
    tmp_path: Path, event_type: str
) -> None:
    process = _FakeProcess([_event(event_type, message="authentication required")])
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    with pytest.raises(CodexCliAuthenticationError, match="authentication error"):
        _ = [message async for message in client.receive_response()]


@pytest.mark.asyncio
async def test_nonzero_exit_reports_sanitized_stderr(tmp_path: Path) -> None:
    process = _FakeProcess([], ["not logged in"], returncode=1)
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    with pytest.raises(CodexCliAuthenticationError, match="authentication error"):
        _ = [message async for message in client.receive_response()]


@pytest.mark.asyncio
async def test_process_error_redacts_credential_shapes(tmp_path: Path) -> None:
    raw_secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"
    process = _FakeProcess([], [f"failure token={raw_secret}"], returncode=1)
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    with pytest.raises(CodexCliError) as raised:
        _ = [message async for message in client.receive_response()]

    assert raw_secret not in str(raised.value)
    assert "[REDACTED]" in str(raised.value)


@pytest.mark.asyncio
async def test_malformed_progress_line_is_ignored_after_valid_result(
    tmp_path: Path,
) -> None:
    process = _FakeProcess(
        [
            "not-json",
            _event(
                "item.completed",
                item={"id": "i1", "type": "agent_message", "text": "done"},
            ),
            _event("turn.completed", usage={}),
        ]
    )
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    messages = [message async for message in client.receive_response()]

    assert messages[-1].content[0].text == "done"


@pytest.mark.asyncio
async def test_missing_final_message_is_an_error(tmp_path: Path) -> None:
    process = _FakeProcess([_event("turn.completed", usage={})])
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    with pytest.raises(CodexCliError, match="no final response"):
        _ = [message async for message in client.receive_response()]


@pytest.mark.asyncio
async def test_closing_stream_terminates_active_process(tmp_path: Path) -> None:
    process = _FakeProcess(
        [
            _event(
                "item.completed",
                item={"id": "i1", "type": "agent_message", "text": "partial"},
            ),
            _event("turn.completed", usage={}),
        ],
        returncode=None,
    )
    client = CodexCliAgentClient(
        project_dir=str(tmp_path),
        executable="codex",
        process_factory=_ProcessFactory(process),
    )
    await client.query("work")

    stream = client.receive_response()
    message = await anext(stream)
    await stream.aclose()

    assert message.content[0].text == "partial"
    assert process.terminated is True


def test_codex_client_does_not_claim_workpilot_subagents(tmp_path: Path) -> None:
    client = CodexCliAgentClient(project_dir=str(tmp_path), executable="codex")

    assert client.supports_subagents() is False
    assert client.provider_name() == "openai-codex-cli"
    assert not hasattr(client, "_tool_executor")


def test_oneshot_openai_codex_mode_uses_cli(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_AUTH_MODE", "codex-cli")

    client = _build_client(
        provider="openai",
        model="gpt-5.6-sol",
        system_prompt="Be concise.",
        project_dir=str(tmp_path),
        spec_dir=None,
        max_turns=1,
    )

    assert isinstance(client, CodexCliAgentClient)


def test_oneshot_rest_default_model_is_not_forced_on_codex(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("OPENAI_AUTH_MODE", "codex-cli")

    client = _build_client(
        provider="openai",
        model="gpt-4o-mini",
        system_prompt=None,
        project_dir=str(tmp_path),
        spec_dir=None,
        max_turns=1,
    )

    assert isinstance(client, CodexCliAgentClient)
    assert client.model == "default"


@pytest.mark.asyncio
async def test_oneshot_returns_empty_text_on_cli_failure(monkeypatch) -> None:
    class _FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            return None

        async def query(self, prompt: str) -> None:
            return None

        async def receive_response(self):
            raise CodexCliError("Codex CLI failed safely")
            yield  # pragma: no cover

    monkeypatch.setattr("core.oneshot._build_client", lambda *args: _FailingClient())

    result = await oneshot_completion("title this", provider="openai", model="gpt-5.5")

    assert result == ""
