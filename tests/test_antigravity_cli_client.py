"""Tests for the Google Antigravity CLI-backed agent client (`agy`, stream-json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.agent_client import (
    AntigravityCliAgentClient,
    ContentBlockType,
    MessageRole,
)
from core.agent_clients.antigravity_cli import (
    AntigravityCliAuthenticationError,
    AntigravityCliError,
    antigravity_effort,
    antigravity_permission_for,
    antigravity_stdin_payload,
    build_antigravity_args,
    context_tokens_from_usage,
)
from harness.domain import CallUsage


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


CONVERSATION = "055a398f-db14-4c5f-abbb-1bf03f8120a7"


def _init() -> str:
    return json.dumps(
        {
            "event": "init",
            "conversation_id": CONVERSATION,
            "init": {"cwd": "/x", "tools": [], "permission_mode": "always-proceed"},
        }
    )


def _step(index: int, step_type: str, state: str, **values: object) -> str:
    return json.dumps(
        {
            "event": "step_update",
            "step_update": {
                "conversation_id": CONVERSATION,
                "step_index": index,
                "state": state,
                "step_type": step_type,
                **values,
            },
        }
    )


def _result(status: str = "SUCCESS", **values: object) -> str:
    return json.dumps(
        {
            "event": "result",
            "result": {
                "conversation_id": CONVERSATION,
                "status": status,
                "duration_seconds": 1.5,
                "num_turns": 1,
                **values,
            },
        }
    )


def _client(tmp_path: Path, factory: _ProcessFactory, **kwargs):
    return AntigravityCliAgentClient(
        project_dir=str(tmp_path),
        executable="agy",
        process_factory=factory,
        **kwargs,
    )


async def _collect(client, prompt: str = "do it"):
    await client.query(prompt)
    return [message async for message in client.receive_response()]


# --- argument building ------------------------------------------------------


def test_coder_args_are_shell_free_stream_json_with_sandboxed_permissions() -> None:
    args = build_antigravity_args(
        executable="agy",
        model="gemini-3-pro",
        conversation_id=None,
        effort="high",
        permission="full",
    )

    assert args == [
        "agy",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        "gemini-3-pro",
        "--effort",
        "high",
        "--dangerously-skip-permissions",
        "--sandbox",
    ]
    assert "-p" not in args


def test_edit_only_types_get_accept_edits_and_no_blanket_approval() -> None:
    args = build_antigravity_args(
        executable="agy",
        model=None,
        conversation_id=CONVERSATION,
        effort=None,
        permission="edits",
    )

    assert args[args.index("--conversation") + 1] == CONVERSATION
    assert args[args.index("--mode") + 1] == "accept-edits"
    assert "--dangerously-skip-permissions" not in args
    assert "--model" not in args and "--effort" not in args


@pytest.mark.parametrize("bad", ["x&calc", "a b", "%TEMP%", 'q"'])
def test_unsafe_option_values_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        build_antigravity_args(
            executable="agy",
            model=bad,
            conversation_id=None,
            effort=None,
            permission="full",
        )


def test_unknown_permission_level_is_refused() -> None:
    with pytest.raises(ValueError):
        build_antigravity_args(
            executable="agy",
            model=None,
            conversation_id=None,
            effort=None,
            permission="read-only",
        )


def test_stdin_payload_is_one_user_event_line() -> None:
    payload = antigravity_stdin_payload('say "hi" & exit')
    assert payload.endswith(b"\n")
    assert json.loads(payload) == {
        "event": "user",
        "message": {"content": 'say "hi" & exit'},
    }


@pytest.mark.parametrize(
    ("level", "model", "expected"),
    [
        ("low", None, "low"),
        ("medium", "gemini-3-pro", "medium"),
        ("ultrathink", None, "high"),
        ("none", None, None),
        (None, None, None),
        ("high", "gemini-3.8-flash-medium", None),
    ],
)
def test_effort_mapping(level, model, expected) -> None:
    assert antigravity_effort(level, model) == expected


# --- rights -----------------------------------------------------------------


def test_read_only_types_are_refused_at_construction(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="read-only"):
        AntigravityCliAgentClient(project_dir=str(tmp_path), agent_type="pr_reviewer")
    with pytest.raises(ValueError):
        antigravity_permission_for("spec_critic")


def test_permission_levels_follow_the_declaration() -> None:
    assert antigravity_permission_for("coder") == "full"
    # Unregistered types stay permissive, as the executor keeps them.
    assert antigravity_permission_for("not-a-type") == "full"


# --- usage ------------------------------------------------------------------


def test_context_tokens_use_total_to_decide_whether_cache_is_separate() -> None:
    # total covers input + output + thinking + cache: cache is separate.
    assert (
        context_tokens_from_usage(
            {
                "input_tokens": 100,
                "output_tokens": 10,
                "thinking_tokens": 5,
                "cache_read_tokens": 900,
                "total_tokens": 1015,
            }
        )
        == 1000
    )
    # total covers only input + output + thinking: cache is inside input.
    assert (
        context_tokens_from_usage(
            {
                "input_tokens": 1000,
                "output_tokens": 10,
                "thinking_tokens": 5,
                "cache_read_tokens": 900,
                "total_tokens": 1015,
            }
        )
        == 1000
    )
    # No total: count the cache reads (over-counting is the safe side).
    assert (
        context_tokens_from_usage({"input_tokens": 100, "cache_read_tokens": 50}) == 150
    )
    assert context_tokens_from_usage({}) is None
    assert context_tokens_from_usage(None) is None


# --- a turn -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_turn_parses_stream_json_events(tmp_path: Path) -> None:
    process = _FakeProcess(
        [
            _init(),
            _step(0, "user_input", "DONE"),
            _step(1, "tool", "ACTIVE", tool_name="view_file"),
            _step(
                1,
                "tool",
                "DONE",
                tool_name="view_file",
                tool_info={"path": "README.md"},
                usage={"input_tokens": 500, "output_tokens": 20},
            ),
            _step(2, "agent_response", "ACTIVE", text_delta="All "),
            _step(2, "agent_response", "ACTIVE", text_delta="done."),
            _step(
                2,
                "agent_response",
                "DONE",
                usage={"input_tokens": 800, "output_tokens": 30},
            ),
            _result(
                response="All done.",
                usage={
                    "input_tokens": 1300,
                    "output_tokens": 50,
                    "thinking_tokens": 7,
                    "cache_read_tokens": 0,
                    "total_tokens": 1357,
                },
            ),
        ]
    )
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, model="gemini-3-pro", system_prompt="SYS")

    messages = await _collect(client, "fix & $(rm)")

    args, kwargs = factory.calls[0]
    assert "fix & $(rm)" not in " ".join(args)
    assert kwargs["cwd"] == str(tmp_path)
    sent = json.loads(process.stdin.data)
    assert sent["event"] == "user"
    assert sent["message"]["content"].startswith("SYS")
    assert sent["message"]["content"].endswith("fix & $(rm)")
    assert process.stdin.closed

    assert messages[0].content[0].type == ContentBlockType.TOOL_USE
    assert messages[0].content[0].tool_name == "view_file"
    assert messages[0].content[0].tool_input == {"path": "README.md"}
    assert messages[1].content[0].type == ContentBlockType.TOOL_RESULT
    texts = [
        m.content[0].text
        for m in messages
        if m.role == MessageRole.ASSISTANT
        and m.content[0].type == ContentBlockType.TEXT
    ]
    # The streamed text once, not again from `result.response`.
    assert texts == ["All done."]

    assert client.last_session_id == CONVERSATION
    assert client.resumes_native_session()
    assert client.last_context_tokens == 800
    assert client.context_window_tokens is None
    assert client.context_usage_source == "reported"
    assert client.last_usage == {
        "input_tokens": 1300,
        "output_tokens": 50,
        "thinking_tokens": 7,
        "cache_read_tokens": 0,
        "total_tokens": 1357,
    }
    # One call per step that reported usage; the process total is not a call.
    assert client.usage_ledger.calls == [
        CallUsage(prompt=500, cache_read=None, cache_write=None, output=20),
        CallUsage(prompt=800, cache_read=None, cache_write=None, output=30),
    ]


@pytest.mark.asyncio
async def test_result_response_is_used_when_nothing_streamed(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess([_init(), _result(response="Short answer.")])
    )
    client = _client(tmp_path, factory)

    messages = await _collect(client)

    assert messages[-1].content[0].text == "Short answer."
    assert client.context_usage_source == "estimated"


@pytest.mark.asyncio
async def test_second_turn_resumes_the_conversation(tmp_path: Path) -> None:
    first = _FakeProcess([_init(), _result(response="one")])
    second = _FakeProcess([_init(), _result(response="two")])
    factory = _ProcessFactory(first, second)
    client = _client(tmp_path, factory, system_prompt="SYS")

    await _collect(client, "first")
    await _collect(client, "second")

    args = factory.calls[1][0]
    assert args[args.index("--conversation") + 1] == CONVERSATION
    assert json.loads(second.stdin.data)["message"]["content"] == "second"


@pytest.mark.asyncio
async def test_denied_actions_are_surfaced_as_a_status_line(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [
                _result(
                    response="I could not run the tests.",
                    denied_actions=[{"tool": "run_command", "command": "npm test"}],
                )
            ]
        )
    )
    client = _client(tmp_path, factory, agent_type="coder")

    messages = await _collect(client)

    status = [m for m in messages if m.role == MessageRole.SYSTEM]
    assert status and "denied 1 action" in status[0].content[0].text


@pytest.mark.asyncio
async def test_error_status_raises_redacted(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [_result(status="ERROR", error="quota blown for key sk-abcdefghijklmnop")],
            returncode=1,
        )
    )
    client = _client(tmp_path, factory)

    with pytest.raises(AntigravityCliError) as excinfo:
        await _collect(client)

    assert "sk-abcdefghijklmnop" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_stderr_error_marker_is_reported(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [],
            stderr_lines=["warming up", "error: agent crashed token=hunter2"],
            returncode=1,
        )
    )
    client = _client(tmp_path, factory)

    with pytest.raises(AntigravityCliError) as excinfo:
        await _collect(client)

    text = str(excinfo.value)
    assert "agent crashed" in text
    assert "warming up" not in text
    assert "hunter2" not in text


@pytest.mark.asyncio
async def test_missing_sign_in_is_a_clear_auth_error(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess([], stderr_lines=["error: authentication required"], returncode=1)
    )
    client = _client(tmp_path, factory)

    with pytest.raises(AntigravityCliAuthenticationError, match="sign in"):
        await _collect(client)


@pytest.mark.asyncio
async def test_unknown_model_retries_once_with_the_cli_default(tmp_path: Path) -> None:
    rejected = _FakeProcess(
        [_result(status="ERROR", error="unknown model: does-not-exist-model")],
        stderr_lines=["error: unknown model: does-not-exist-model"],
        returncode=1,
    )
    retried = _FakeProcess([_result(response="ok")])
    factory = _ProcessFactory(rejected, retried)
    client = _client(tmp_path, factory, model="does-not-exist-model")

    messages = await _collect(client)

    assert messages[-1].content[0].text == "ok"
    assert "--model" in factory.calls[0][0]
    assert "--model" not in factory.calls[1][0]


@pytest.mark.asyncio
async def test_missing_executable_is_a_clear_error(tmp_path: Path, monkeypatch) -> None:
    from core.agent_clients import antigravity_cli

    monkeypatch.setattr(antigravity_cli, "find_executable", lambda name: None)
    client = AntigravityCliAgentClient(
        project_dir=str(tmp_path), process_factory=_ProcessFactory()
    )

    with pytest.raises(AntigravityCliError, match="not installed"):
        await _collect(client)


def test_contract_attributes_and_identity(tmp_path: Path) -> None:
    client = _client(tmp_path, _ProcessFactory(), conversation_id=CONVERSATION)

    assert client.provider_name() == "antigravity"
    assert client.supports_subagents() is False
    assert client.resumes_native_session() is True
    assert client.last_session_id == CONVERSATION
    assert client.last_usage is None
    assert client.last_context_tokens is None
    assert client.context_window_tokens is None


# --- factory ----------------------------------------------------------------


@pytest.mark.parametrize("provider", ["antigravity", "agy", "AGY"])
def test_create_agent_client_routes_antigravity(tmp_path: Path, provider) -> None:
    from core.client import create_agent_client

    client = create_agent_client(
        project_dir=tmp_path,
        spec_dir=tmp_path,
        model="gemini-3-pro",
        provider=provider,
        resume=CONVERSATION,
    )

    assert isinstance(client, AntigravityCliAgentClient)
    assert client.model == "gemini-3-pro"
    assert client.last_session_id == CONVERSATION


def test_create_agent_client_refuses_a_read_only_type(tmp_path: Path) -> None:
    from core.client import create_agent_client

    with pytest.raises(ValueError, match="read-only"):
        create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="gemini-3-pro",
            provider="antigravity",
            agent_type="pr_reviewer",
        )


def test_antigravity_never_asks_for_the_claude_oauth_token() -> None:
    from core.auth import provider_requires_claude_oauth

    assert provider_requires_claude_oauth("antigravity") is False
    assert provider_requires_claude_oauth("agy") is False


def test_agy_alias_resolves_in_the_capability_matrix() -> None:
    from skills_registry.providers import get_provider_capabilities

    caps = get_provider_capabilities("agy")
    assert caps.adapter == "AntigravityCliAgentClient"
    assert caps.context_usage == "reported"
