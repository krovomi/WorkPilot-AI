"""Tests for the pi-backed agent client (`pi --mode json`).

The event streams come from `tests/fixtures/pi/`: real output of pi 1.3.0,
captured by `tests/fixtures/pi/capture.py` against a scripted fake model. The
contract tested here is pi's, not the model's.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.agent_client import ContentBlockType, MessageRole, PiCliAgentClient
from core.agent_clients.pi_cli import (
    PI_THINKING_LEVELS,
    PROJECT_SKILLS_DIR,
    PiCliAuthenticationError,
    PiCliError,
    build_pi_args,
    pi_thinking_level,
    pi_tool_allowlist,
    pi_trust_state,
)
from harness.domain import CallUsage, from_pi_usage

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "pi"
SESSION = "11111111-1111-4111-8111-111111111111"


def _fixture(name: str) -> list[str]:
    return (FIXTURES / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()


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


def _client(tmp_path: Path, factory: _ProcessFactory, **kwargs) -> PiCliAgentClient:
    kwargs.setdefault("spec_dir", tmp_path / "spec")
    return PiCliAgentClient(
        project_dir=str(tmp_path),
        executable="pi",
        process_factory=factory,
        **kwargs,
    )


async def _collect(client: PiCliAgentClient, prompt: str = "do it"):
    await client.query(prompt)
    return [message async for message in client.receive_response()]


def _flag(args: tuple[str, ...], flag: str) -> str | None:
    args_list = list(args)
    return args_list[args_list.index(flag) + 1] if flag in args_list else None


# --- rights: the type's declaration becomes pi's allowlist ------------------


def test_coder_allowlist_is_its_declaration_in_pi_words() -> None:
    allowed = pi_tool_allowlist("coder")
    assert allowed is not None
    assert {"read", "bash", "edit", "write", "grep", "find", "ls"} <= set(allowed)
    # The MCP tools of the servers the type declares, as pi names them
    # (`mcp__<server>__<tool>`, every other character replaced by `_`).
    mcp = [name for name in allowed if name.startswith("mcp__")]
    assert mcp and all(name.replace("_", "").isalnum() for name in mcp)
    assert any(name.startswith("mcp__workpilot_code__") for name in mcp)
    # Canonical names pi has no tool for (WebFetch, WebSearch) are not guessed.
    assert not {"WebFetch", "WebSearch", "webfetch", "web_search"} & set(allowed)


@pytest.mark.parametrize("agent_type", ["pr_reviewer", "spec_critic", "analyzer"])
def test_read_only_types_get_no_write_edit_bash(agent_type: str) -> None:
    from agents.tools_pkg.permissions import declared_tools

    assert not (declared_tools(agent_type) & {"Write", "Edit", "Bash"})
    allowed = pi_tool_allowlist(agent_type)
    assert allowed is not None
    assert "read" in allowed and "ls" in allowed
    assert not {"write", "edit", "bash", "powershell"} & set(allowed)


def test_powershell_is_never_granted() -> None:
    from agents.tools_pkg.permissions import get_all_agent_types

    for agent_type in get_all_agent_types():
        allowed = pi_tool_allowlist(agent_type)
        assert allowed is not None and "powershell" not in allowed, agent_type


def test_an_unregistered_type_is_permissive_like_the_other_clis() -> None:
    assert pi_tool_allowlist("not-a-registered-type") is None


def test_the_allowlist_names_come_from_the_harness_matrix() -> None:
    """One source for how pi calls `Write`: capabilities/harnesses.yaml."""
    import yaml

    repo_root = Path(__file__).resolve().parent.parent
    matrix = yaml.safe_load(
        (repo_root / "capabilities" / "harnesses.yaml").read_text(encoding="utf-8")
    )
    assert set(matrix["pi"]["tools"].values()) <= set(pi_tool_allowlist("coder"))


# --- argument building ------------------------------------------------------


def test_first_turn_names_the_session_and_passes_the_allowlist() -> None:
    args = build_pi_args(
        executable="pi",
        model="anthropic/claude-sonnet-4-6",
        session_id=SESSION,
        resume=False,
        tools=["read", "grep", "find", "ls"],
        thinking_level="high",
        project_skills=True,
    )
    assert args[:3] == ["pi", "--mode", "json"]
    assert args[args.index("--session-id") + 1] == SESSION
    assert "--session" not in args
    assert args[args.index("--model") + 1] == "anthropic/claude-sonnet-4-6"
    assert args[args.index("--thinking") + 1] == "high"
    assert args[args.index("--tools") + 1] == "read,grep,find,ls"
    assert args[args.index("--skill") + 1] == PROJECT_SKILLS_DIR
    assert "--approve" not in args and "-a" not in args


def test_a_later_turn_resumes_by_id_not_by_path() -> None:
    args = build_pi_args(
        executable="pi",
        model=None,
        session_id=SESSION,
        resume=True,
        tools=None,
        thinking_level=None,
        project_skills=False,
    )
    assert args[args.index("--session") + 1] == SESSION
    assert "--session-id" not in args
    assert "--model" not in args and "--thinking" not in args
    assert "--tools" not in args and "--skill" not in args
    assert not any("/" in a or "\\" in a for a in args[1:])


def test_an_empty_allowlist_is_still_an_allowlist() -> None:
    args = build_pi_args(
        executable="pi",
        model=None,
        session_id=SESSION,
        resume=False,
        tools=[],
        thinking_level=None,
        project_skills=False,
    )
    assert "--no-tools" in args and "--tools" not in args


@pytest.mark.parametrize(
    "bad",
    ["read bash", "read;rm", "../x", "a|b", "$(x)", "mcp__a__b,c", "read\n"],
)
def test_unsafe_tool_names_are_refused(bad: str) -> None:
    with pytest.raises(ValueError, match="tool name"):
        build_pi_args(
            executable="pi",
            model=None,
            session_id=SESSION,
            resume=False,
            tools=[bad],
            thinking_level=None,
            project_skills=False,
        )


@pytest.mark.parametrize(
    "bad", ["ses 1", "../x", "a;b", "C:\\x", "x.jsonl", "a/b", "short", "ses_1"]
)
def test_a_session_id_is_never_a_path(bad: str) -> None:
    """pi reads `--session` as a path once it holds `/`, `\\` or `.jsonl`, and
    writes `--session-id` into a file name: only an id-shaped value passes."""
    with pytest.raises(ValueError, match="session id"):
        build_pi_args(
            executable="pi",
            model=None,
            session_id=bad,
            resume=False,
            tools=None,
            thinking_level=None,
            project_skills=False,
        )


@pytest.mark.parametrize("bad", ["gpt 5", "a;b", "C:\\x", "$(x)", "a|b"])
def test_unsafe_model_values_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        build_pi_args(
            executable="pi",
            model=bad,
            session_id=SESSION,
            resume=False,
            tools=None,
            thinking_level=None,
            project_skills=False,
        )


def test_an_unknown_thinking_level_never_reaches_the_command() -> None:
    with pytest.raises(ValueError, match="thinking"):
        build_pi_args(
            executable="pi",
            model=None,
            session_id=SESSION,
            resume=False,
            tools=None,
            thinking_level="12000 tokens",
            project_skills=False,
        )


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("none", "off"),
        ("low", "low"),
        ("medium", "medium"),
        ("high", "high"),
        ("ultrathink", "max"),
        ("xhigh", "xhigh"),
        ("12000 tokens", None),
        (None, None),
        ("", None),
    ],
)
def test_thinking_levels_map_onto_pi(given, expected) -> None:
    assert pi_thinking_level(given) == expected
    assert expected is None or expected in PI_THINKING_LEVELS


# --- trust: read, reported, never granted ----------------------------------


def _trust_file(tmp_path: Path, decisions: dict) -> Path:
    agent_dir = tmp_path / "pi-agent"
    agent_dir.mkdir(exist_ok=True)
    (agent_dir / "trust.json").write_text(json.dumps(decisions), encoding="utf-8")
    return agent_dir


def test_a_project_without_pi_resources_needs_no_trust(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    assert pi_trust_state(project, agent_dir=tmp_path / "pi-agent") == "not-needed"


def test_trust_is_read_from_the_nearest_ancestor(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    (project / ".pi" / "extensions").mkdir(parents=True)
    worktree = project / ".workpilot" / "worktrees" / "tasks" / "001"
    (worktree / ".pi" / "extensions").mkdir(parents=True)
    agent_dir = _trust_file(tmp_path, {str(project.resolve()): True})
    assert pi_trust_state(project, agent_dir=agent_dir) == "trusted"
    # Trusting the project root covers the worktrees WorkPilot creates under it.
    assert pi_trust_state(worktree, agent_dir=agent_dir) == "trusted"
    agent_dir = _trust_file(tmp_path, {str(project.resolve()): False})
    assert pi_trust_state(worktree, agent_dir=agent_dir) == "untrusted"
    agent_dir = _trust_file(tmp_path, {str(tmp_path / "elsewhere"): True})
    assert pi_trust_state(project, agent_dir=agent_dir) == "undecided"


def test_an_unreadable_trust_file_is_undecided_not_trusted(tmp_path: Path) -> None:
    project = tmp_path / "repo"
    (project / ".pi" / "mcp.json").parent.mkdir(parents=True)
    (project / ".pi" / "mcp.json").write_text("{}", encoding="utf-8")
    agent_dir = tmp_path / "pi-agent"
    agent_dir.mkdir()
    (agent_dir / "trust.json").write_text("{ not json", encoding="utf-8")
    assert pi_trust_state(project, agent_dir=agent_dir) == "undecided"
    (agent_dir / "trust.json").write_text(
        json.dumps({str(project.resolve()): "yes"}), encoding="utf-8"
    )
    assert pi_trust_state(project, agent_dir=agent_dir) == "undecided"


@pytest.mark.asyncio
async def test_the_client_never_writes_trust_and_never_approves(tmp_path: Path) -> None:
    (tmp_path / ".pi" / "extensions").mkdir(parents=True)
    factory = _ProcessFactory(_FakeProcess(_fixture("tool-call")))
    client = _client(tmp_path, factory)
    await _collect(client)
    args, _ = factory.calls[0]
    assert "--approve" not in args and "-a" not in args and "--no-approve" not in args
    assert not list(tmp_path.rglob("trust.json"))


# --- a turn, on the real streams --------------------------------------------


@pytest.mark.asyncio
async def test_turn_sends_prompt_on_stdin_and_parses_the_real_stream(
    tmp_path: Path,
) -> None:
    (tmp_path / ".agents" / "skills").mkdir(parents=True)
    process = _FakeProcess(_fixture("tool-call"))
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, model="claude-sonnet-4-6", system_prompt="SYS")

    messages = await _collect(client, "list $(unsafe) & stuff")

    args, kwargs = factory.calls[0]
    assert "list $(unsafe) & stuff" not in " ".join(args)
    assert str(tmp_path) not in args
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["env"]["PWD"] == str(tmp_path)
    assert kwargs["env"]["PI_CODING_AGENT_SESSION_DIR"] == str(
        tmp_path / "spec" / "pi-sessions"
    )
    assert (tmp_path / "spec" / "pi-sessions").is_dir()
    assert _flag(args, "--model") == "anthropic/claude-sonnet-4-6"
    assert _flag(args, "--skill") == PROJECT_SKILLS_DIR
    assert _flag(args, "--tools") is not None
    stdin = process.stdin.data.decode()
    assert stdin.startswith("SYS") and stdin.endswith("list $(unsafe) & stuff")
    assert process.stdin.closed

    tool_use = messages[0].content[0]
    assert tool_use.type == ContentBlockType.TOOL_USE
    assert tool_use.tool_name == "ls"
    assert tool_use.tool_input == {"path": "."}
    tool_result = messages[1].content[0]
    assert tool_result.type == ContentBlockType.TOOL_RESULT
    assert tool_result.result_content == "AGENTS.md\nREADME.md"
    assert not tool_result.is_error
    assert messages[-1].role == MessageRole.ASSISTANT
    assert messages[-1].content[0].text == "Listed the directory."
    # pi's system and user messages are not WorkPilot's to echo back.
    assert all(m.role in (MessageRole.ASSISTANT, MessageRole.USER) for m in messages)
    assert len(messages) == 3

    assert client.last_session_id == SESSION
    assert client.resumes_native_session()
    assert client.last_context_tokens == 120
    assert client.context_usage_source == "reported"
    assert client.last_usage == {
        "input_tokens": 240,
        "output_tokens": 18,
        "reasoning_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    assert client.usage_ledger.calls == [
        CallUsage(prompt=120, cache_read=0, cache_write=0, output=9, reasoning=0),
        CallUsage(prompt=120, cache_read=0, cache_write=0, output=9, reasoning=0),
    ]


@pytest.mark.asyncio
async def test_second_turn_resumes_the_session_it_named(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(_fixture("tool-call")), _FakeProcess(_fixture("resume-by-id"))
    )
    client = _client(tmp_path, factory, system_prompt="SYS")
    named = client.session_id
    await _collect(client, "first")
    first_args, _ = factory.calls[0]
    # The first turn names the session WorkPilot chose; the header pi prints
    # (here the fixture's id) is what every later turn resumes.
    assert _flag(first_args, "--session-id") == named
    assert client.last_session_id == SESSION

    second = await _collect(client, "second")
    second_args, _ = factory.calls[1]
    assert _flag(second_args, "--session") == SESSION
    assert "--session-id" not in second_args
    assert factory.processes == []  # both processes were consumed, in order
    assert second[-1].content[0].text == "Listed the directory."


@pytest.mark.asyncio
async def test_a_resumed_turn_does_not_resend_the_system_prompt(tmp_path: Path) -> None:
    process = _FakeProcess(_fixture("resume-by-id"))
    factory = _ProcessFactory(process)
    client = _client(tmp_path, factory, session_id=SESSION, system_prompt="SYS")
    assert client.resumes_native_session()
    await _collect(client, "again")
    assert process.stdin.data.decode() == "again"


@pytest.mark.asyncio
async def test_a_401_is_an_authentication_error_even_at_exit_0(tmp_path: Path) -> None:
    factory = _ProcessFactory(_FakeProcess(_fixture("auth-error"), returncode=0))
    client = _client(tmp_path, factory)
    with pytest.raises(PiCliAuthenticationError, match="/login"):
        await _collect(client)


@pytest.mark.asyncio
async def test_an_error_message_is_redacted(tmp_path: Path) -> None:
    error_line = json.dumps(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "boom: Bearer sk-ant-api03-SECRETSECRETSECRETSECRET",
            },
        }
    )
    factory = _ProcessFactory(
        _FakeProcess([error_line, json.dumps({"type": "agent_settled"})])
    )
    client = _client(tmp_path, factory)
    with pytest.raises(PiCliError) as excinfo:
        await _collect(client)
    assert "SECRETSECRET" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_write_under_a_read_only_allowlist_is_reported_refused(
    tmp_path: Path,
) -> None:
    factory = _ProcessFactory(_FakeProcess(_fixture("readonly-write-refused")))
    client = _client(tmp_path, factory)
    messages = await _collect(client)
    result = messages[1].content[0]
    assert result.type == ContentBlockType.TOOL_RESULT
    assert result.is_error
    assert "not found" in result.result_content
    assert not (tmp_path / "should-not-exist.txt").exists()


@pytest.mark.asyncio
async def test_a_truncated_answer_is_an_error_not_a_success(tmp_path: Path) -> None:
    factory = _ProcessFactory(_FakeProcess(_fixture("length")))
    client = _client(tmp_path, factory)
    with pytest.raises(PiCliError, match="output limit"):
        await _collect(client)


@pytest.mark.asyncio
async def test_a_model_the_provider_rejects_is_retried_once_on_the_default(
    tmp_path: Path,
) -> None:
    rejected = json.dumps(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [],
                "stopReason": "error",
                "errorMessage": "404: model not found",
            },
        }
    )
    factory = _ProcessFactory(
        _FakeProcess([rejected]), _FakeProcess(_fixture("unknown-model"))
    )
    client = _client(tmp_path, factory, model="openai/gpt-nope")
    messages = await _collect(client)
    assert client.model == "default"
    assert "--model" not in factory.calls[1][0]
    assert messages[-1].content[0].text == "Hello from the fake model."


@pytest.mark.asyncio
async def test_nonzero_exit_reports_redacted_stderr(tmp_path: Path) -> None:
    factory = _ProcessFactory(
        _FakeProcess(
            [],
            stderr_lines=["fatal: token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
            returncode=2,
        )
    )
    client = _client(tmp_path, factory)
    with pytest.raises(PiCliError) as excinfo:
        await _collect(client)
    assert "ghp_ABCDEFGHIJ" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_no_usage_means_estimated(tmp_path: Path) -> None:
    lines = [
        json.dumps(
            {"type": "session", "version": 3, "id": SESSION, "cwd": "/work/project"}
        ),
        json.dumps(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ok"}],
                    "stopReason": "stop",
                },
            }
        ),
        json.dumps({"type": "agent_settled", "aborted": False}),
    ]
    factory = _ProcessFactory(_FakeProcess(lines))
    client = _client(tmp_path, factory)
    await _collect(client)
    assert client.context_usage_source == "estimated"
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_missing_executable_is_a_clear_error(tmp_path: Path, monkeypatch) -> None:
    from core.agent_clients import pi_cli

    monkeypatch.setattr(pi_cli, "find_executable", lambda name: None)
    client = PiCliAgentClient(
        project_dir=str(tmp_path), process_factory=_ProcessFactory()
    )
    with pytest.raises(PiCliError, match="not installed"):
        await _collect(client)


@pytest.mark.asyncio
async def test_the_subprocess_env_never_carries_the_jev_key(
    tmp_path: Path, monkeypatch
) -> None:
    """The JEV worker strips TYPESAFE_API_KEY before any agent runs; the pi
    subprocess inherits the environment it is given, so what is not there
    cannot leak (S1)."""
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    client = _client(tmp_path, _ProcessFactory())
    env = client._subprocess_env()
    assert "TYPESAFE_API_KEY" not in env
    assert env["PI_CODING_AGENT_SESSION_DIR"] == str(tmp_path / "spec" / "pi-sessions")
    assert env["PI_SKIP_VERSION_CHECK"] == "1"


def test_sessions_never_default_to_the_persons_pi_home(tmp_path: Path) -> None:
    client = PiCliAgentClient(
        project_dir=str(tmp_path), process_factory=_ProcessFactory()
    )
    assert ".pi" not in client.session_dir.parts
    assert "workpilot" in str(client.session_dir)


# --- contract, factory, defaults --------------------------------------------


def test_contract_attributes_and_identity(tmp_path: Path) -> None:
    client = _client(tmp_path, _ProcessFactory())
    assert client.provider_name() == "pi"
    assert client.supports_subagents() is False
    assert client.resumes_native_session() is False
    assert client.last_usage is None
    assert client.last_session_id == client.session_id
    assert client.last_context_tokens is None
    assert client.context_window_tokens is None
    assert client.context_usage_source in {"reported", "estimated"}


def test_from_pi_usage_reads_the_split_pi_normalises() -> None:
    usage = {
        "input": 120,
        "output": 30,
        "cacheRead": 4000,
        "cacheWrite": 80,
        "reasoning": 4,
        "cost": {"total": 0.1},
    }
    assert from_pi_usage(usage) == CallUsage(
        prompt=4200, cache_read=4000, cache_write=80, output=30, reasoning=4
    )
    assert from_pi_usage({"cost": {}}) is None
    assert from_pi_usage("nope") is None


def test_create_agent_client_routes_pi(tmp_path: Path, monkeypatch) -> None:
    from core.client import create_agent_client

    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-agent"))
    client = create_agent_client(
        project_dir=tmp_path,
        spec_dir=tmp_path / "spec",
        model="anthropic/claude-sonnet-4-6",
        provider="pi",
        resume=SESSION,
    )
    assert isinstance(client, PiCliAgentClient)
    assert client.model == "anthropic/claude-sonnet-4-6"
    assert client.last_session_id == SESSION
    assert client.resumes_native_session()
    assert client.session_dir == tmp_path / "spec" / "pi-sessions"


def test_pi_never_asks_for_the_claude_oauth_token() -> None:
    from core.auth import provider_requires_claude_oauth

    assert provider_requires_claude_oauth("pi") is False


def test_pi_phase_default_is_the_cli_default(tmp_path: Path) -> None:
    from phase_config import get_phase_model

    assert get_phase_model(tmp_path, "coding", cli_provider="pi") == "default"


def test_pi_is_declared_in_both_capability_matrices() -> None:
    from skills_registry.providers import get_provider_capabilities

    caps = get_provider_capabilities("pi")
    assert caps.has_adapter and caps.adapter == "PiCliAgentClient"
    assert not caps.supports_subagents
    assert caps.degrades_to is None
