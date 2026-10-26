"""Tests for the Agent Client Protocol client (`core/agent_clients/acp.py`).

The exchanges come from `tests/fixtures/acp/gemini-cli/`: real messages of
Gemini CLI 0.65, captured by the `capture.py` beside them against a scripted
fake model. A fake agent replays them: each request the client sends is
answered by what Gemini answered to the same request, and what Gemini asked
in between is asked again. What the client answered is recorded and checked.
"""

from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
from typing import Any

import pytest
from core.agent_client import AcpAgentClient, AcpAuthenticationError, AcpError
from core.agent_clients.acp import CLIENT_CAPABILITIES, acp_model, kind_allowed
from core.agent_clients.acp_permissions import (
    ANSWER_PREFIX,
    PermissionOption,
    PermissionQuestion,
    StdinBroker,
    UnansweredBroker,
    _StdinAnswers,
    broker_for,
    display_text,
)
from core.agent_clients.base import ContentBlockType, MessageRole
from harness.domain import CallUsage, from_acp_usage
from skills_registry.providers import _parse_acp, get_provider_capabilities

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "acp" / "gemini-cli"
SESSION = "$SESSION"


def _fixture(name: str, project: Path) -> list[dict[str, Any]]:
    text = (FIXTURES / f"{name}.jsonl").read_text(encoding="utf-8")
    # The path goes into JSON strings: escaped, so a Windows path's backslashes stay literal.
    text = text.replace("$PROJECT", json.dumps(str(project.resolve()))[1:-1])
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class _Stdout:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()

    async def readline(self) -> bytes:
        return await self.queue.get()


class _Stderr:
    async def read(self) -> bytes:
        return b""


class _Stdin:
    def __init__(self, agent: FakeAgent) -> None:
        self._agent = agent
        self._buffer = b""

    def write(self, data: bytes) -> None:
        self._buffer += data
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            self._agent.received(json.loads(line))

    async def drain(self) -> None:
        await asyncio.sleep(0)

    def close(self) -> None:
        self._agent.closed()


class FakeAgent:
    """An agent process that replays a captured exchange."""

    def __init__(self, script: list[dict[str, Any]]) -> None:
        self.script = script
        self.used = [False] * len(script)
        self.sent: list[dict[str, Any]] = []
        self.argv: tuple[str, ...] = ()
        self.env: dict[str, str] = {}
        self.ids: dict[Any, Any] = {}
        self.returncode: int | None = None
        self.stdout = _Stdout()
        self.stderr = _Stderr()
        self.stdin = _Stdin(self)

    async def __call__(self, *argv: str, **kwargs: Any) -> FakeAgent:
        self.argv = argv
        self.env = kwargs.get("env") or {}
        return self

    def _emit(self, message: dict[str, Any]) -> None:
        if "id" in message and "method" not in message:
            message = {**message, "id": self.ids.get(message["id"], message["id"])}
        self.stdout.queue.put_nowait((json.dumps(message) + "\n").encode())

    def received(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
        is_request = "method" in message and "id" in message
        is_response = "method" not in message
        for index, line in enumerate(self.script):
            if self.used[index] or line["dir"] != "out":
                continue
            expected = line["msg"]
            if (
                is_request
                and expected.get("method") == message["method"]
                and "id" in expected
            ):
                self.ids[expected["id"]] = message["id"]
            elif not (
                is_response
                and "method" not in expected
                and expected.get("id") == message.get("id")
            ):
                continue
            self.used[index] = True
            for follow in range(index + 1, len(self.script)):
                if self.script[follow]["dir"] == "out":
                    break
                self.used[follow] = True
                self._emit(self.script[follow]["msg"])
            return

    def closed(self) -> None:
        self.returncode = 0
        self.stdout.queue.put_nowait(b"")

    async def wait(self) -> int:
        return self.returncode or 0

    def terminate(self) -> None:
        self.closed()

    def kill(self) -> None:
        self.closed()

    def answers(self, method: str | None = None) -> list[dict[str, Any]]:
        return (
            [m for m in self.sent if "method" not in m]
            if method is None
            else [m for m in self.sent if m.get("method") == method]
        )


class RecordingBroker:
    def __init__(self, answer: str | None) -> None:
        self.answer = answer
        self.questions: list[PermissionQuestion] = []

    async def ask(self, question: PermissionQuestion) -> str | None:
        self.questions.append(question)
        return self.answer


def _client(
    project: Path,
    agent: FakeAgent,
    *,
    agent_type: str = "coder",
    broker: Any = None,
    session_id: str | None = None,
) -> AcpAgentClient:
    return AcpAgentClient(
        provider="gemini-cli",
        project_dir=str(project),
        agent_type=agent_type,
        session_id=session_id,
        spec_dir=project / ".workpilot" / "specs" / "001",
        broker=broker or RecordingBroker(None),
        executable="gemini",
        process_factory=agent,
    )


async def _turn(client: AcpAgentClient, prompt: str = "Do it.") -> list[Any]:
    await client.query(prompt)
    return [message async for message in client.receive_response()]


def _texts(messages: list[Any]) -> list[str]:
    return [
        block.text
        for message in messages
        for block in message.content
        if block.type == ContentBlockType.TEXT and message.role == MessageRole.ASSISTANT
    ]


def _tool_results(messages: list[Any]) -> list[Any]:
    return [
        block
        for m in messages
        for block in m.content
        if block.type == ContentBlockType.TOOL_RESULT
    ]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    (root / ".workpilot" / "specs" / "001").mkdir(parents=True)
    return root


# ── the turn, as Gemini plays it ──────────────────────────────────────────


async def test_a_write_is_asked_on_the_card_and_written_through_the_guard(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("write-allowed", project))
    broker = RecordingBroker("proceed_once")
    client = _client(project, agent, broker=broker)
    async with client:
        messages = await _turn(client)

    initialize = agent.answers("initialize")[0]["params"]
    assert initialize["clientCapabilities"] == CLIENT_CAPABILITIES
    assert agent.argv == ("gemini", "--acp")
    # The question the person saw: Gemini's title, kind and options, the path
    # shown relative to the project.
    [question] = broker.questions
    assert question.title == "Writing to notes/ok.txt"
    assert question.kind == "edit"
    assert [o.option_id for o in question.options] == [
        "proceed_always",
        "proceed_once",
        "cancel",
    ]
    assert question.locations == ("notes/ok.txt",)
    permission_answer = next(m for m in agent.answers() if m["id"] == 0)
    assert permission_answer["result"] == {
        "outcome": {"outcome": "selected", "optionId": "proceed_once"}
    }
    # The write came back to WorkPilot and landed.
    assert (project / "notes" / "ok.txt").read_text(encoding="utf-8") == "hello\n"
    write_answer = next(m for m in agent.answers() if m["id"] == 1)
    assert write_answer == {"jsonrpc": "2.0", "id": 1, "result": {}}
    # The turn: the tool use/result pair, then the answer.
    [result] = _tool_results(messages)
    assert result.is_error is False
    assert _texts(messages) == ["Done."]
    # Usage: the window from usage_update, the turn from the answer.
    assert client.last_context_tokens == 129
    assert client.context_window_tokens == 1048576
    assert client.context_usage_source == "exact"
    assert client.last_usage["input_tokens"] == 240
    assert client.last_session_id == SESSION
    # The mode was already `default`: nothing to set.
    assert agent.answers("session/set_mode") == []


async def test_a_refusal_from_the_person_reaches_the_agent(project: Path) -> None:
    agent = FakeAgent(_fixture("write-rejected", project))
    client = _client(project, agent, broker=RecordingBroker("cancel"))
    async with client:
        messages = await _turn(client)
    answer = next(m for m in agent.answers() if m["id"] == 0)
    assert answer["result"]["outcome"]["optionId"] == "cancel"
    assert not (project / "notes").exists()
    [result] = _tool_results(messages)
    assert result.is_error is True
    assert "canceled by the user" in str(result.result_content)


async def test_no_answer_is_a_refusal(project: Path) -> None:
    agent = FakeAgent(_fixture("write-rejected", project))
    client = _client(project, agent, broker=RecordingBroker(None))
    async with client:
        await _turn(client)
    answer = next(m for m in agent.answers() if m["id"] == 0)
    assert answer["result"]["outcome"] == {"outcome": "selected", "optionId": "cancel"}


async def test_an_answer_naming_no_offered_option_is_a_refusal(project: Path) -> None:
    agent = FakeAgent(_fixture("write-rejected", project))
    client = _client(project, agent, broker=RecordingBroker("yolo_everything"))
    async with client:
        await _turn(client)
    answer = next(m for m in agent.answers() if m["id"] == 0)
    assert answer["result"]["outcome"]["optionId"] == "cancel"


async def test_a_read_only_type_runs_in_plan_mode_where_gemini_refuses_the_write(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("plan-mode-write", project))
    broker = RecordingBroker("proceed_once")
    client = _client(project, agent, agent_type="spec_critic", broker=broker)
    async with client:
        messages = await _turn(client)
    [set_mode] = agent.answers("session/set_mode")
    assert set_mode["params"]["modeId"] == "plan"
    assert broker.questions == []
    [result] = _tool_results(messages)
    assert result.is_error is True
    assert "denied by policy" in str(result.result_content)
    # "[MODE_UPDATE] plan" came before the turn: it is not the answer.
    assert _texts(messages) == ["Done."]


async def test_a_question_outside_the_declared_tools_is_refused_without_asking(
    project: Path,
) -> None:
    # architecture_visualizer declares Write but not Bash.
    agent = FakeAgent(_fixture("shell-asked", project))
    broker = RecordingBroker("proceed_once")
    client = _client(
        project, agent, agent_type="architecture_visualizer", broker=broker
    )
    async with client:
        await _turn(client)
    assert broker.questions == []
    answer = next(m for m in agent.answers() if m["id"] == 0)
    assert answer["result"]["outcome"]["optionId"] == "cancel"


async def test_a_shell_question_reaches_a_type_that_declares_bash(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("shell-asked", project))
    broker = RecordingBroker("cancel")
    client = _client(project, agent, broker=broker)
    async with client:
        await _turn(client)
    [question] = broker.questions
    assert (question.kind, question.title) == ("execute", "touch made.txt")


async def test_a_tool_the_type_does_not_declare_that_runs_unasked_stops_the_turn(
    project: Path,
) -> None:
    # Gemini runs `echo hi` without asking; architecture_visualizer has no Bash.
    agent = FakeAgent(_fixture("shell-unasked", project))
    client = _client(project, agent, agent_type="architecture_visualizer")
    async with client:
        with pytest.raises(
            AcpError, match="kind `execute`.*does not declare; the turn was stopped"
        ):
            await _turn(client)
    assert agent.answers("session/cancel"), "the turn is cancelled on the agent's side"


async def test_the_same_unasked_command_is_fine_for_a_type_with_bash(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("shell-unasked", project))
    client = _client(project, agent)
    async with client:
        messages = await _turn(client)
    assert _texts(messages) == ["Done."]


async def test_a_session_is_loaded_and_its_replayed_history_is_not_the_answer(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("resume", project))
    client = _client(project, agent, session_id=SESSION)
    await client.resume([])
    async with client:
        messages = await _turn(client, "And now?")
    [load] = agent.answers("session/load")
    assert load["params"]["sessionId"] == SESSION
    assert agent.answers("session/new") == []
    assert _texts(messages) == ["Done."]
    assert _tool_results(messages) == []
    # A loaded session already holds the system prompt.
    [prompt] = agent.answers("session/prompt")
    assert prompt["params"]["prompt"] == [{"type": "text", "text": "And now?"}]


async def test_the_system_prompt_goes_in_the_first_turn_of_a_new_session(
    project: Path,
) -> None:
    agent = FakeAgent(_fixture("write-rejected", project))
    client = _client(project, agent, broker=RecordingBroker("cancel"))
    client.system_prompt = "You are the coder."
    async with client:
        await _turn(client)
    [prompt] = agent.answers("session/prompt")
    assert prompt["params"]["prompt"][0]["text"].startswith(
        "You are the coder.\n\nDo it."
    )


async def test_no_login_names_the_fix(project: Path, monkeypatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    agent = FakeAgent(_fixture("auth-required", project))
    client = _client(project, agent)
    async with client:
        with pytest.raises(
            AcpAuthenticationError, match="not signed in.*GEMINI_API_KEY"
        ):
            await _turn(client)
    assert agent.answers("authenticate") == []


def _scripted(*steps: tuple[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"dir": d, "msg": {"jsonrpc": "2.0", **m}} for d, m in steps]


_INIT = (
    ("out", {"id": 0, "method": "initialize"}),
    (
        "in",
        {
            "id": 0,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False},
                "authMethods": [{"id": "gemini-api-key", "name": "key"}],
            },
        },
    ),
)


async def test_a_declared_login_method_is_tried_once_when_its_variable_is_set(
    project: Path, monkeypatch
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "sk-test-0000")
    agent = FakeAgent(
        _scripted(
            *_INIT,
            ("out", {"id": 1, "method": "session/new"}),
            (
                "in",
                {
                    "id": 1,
                    "error": {"code": -32000, "message": "Gemini API key is missing"},
                },
            ),
            ("out", {"id": 2, "method": "authenticate"}),
            ("in", {"id": 2, "result": {}}),
            ("out", {"id": 3, "method": "session/new"}),
            ("in", {"id": 3, "result": {"sessionId": "s-1"}}),
            ("out", {"id": 4, "method": "session/prompt"}),
            (
                "in",
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": "s-1",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "ok"},
                        },
                    },
                },
            ),
            ("in", {"id": 4, "result": {"stopReason": "end_turn"}}),
        )
    )
    client = _client(project, agent)
    async with client:
        messages = await _turn(client)
    assert [m["params"]["methodId"] for m in agent.answers("authenticate")] == [
        "gemini-api-key"
    ]
    assert _texts(messages) == ["ok"]
    # No usage at all: the fill is only estimated.
    assert client.context_usage_source == "estimated"


async def test_a_session_without_declared_load_starts_over_with_the_log(
    project: Path,
) -> None:
    agent = FakeAgent(
        _scripted(
            *_INIT,
            ("out", {"id": 1, "method": "session/new"}),
            ("in", {"id": 1, "result": {"sessionId": "s-2"}}),
            ("out", {"id": 2, "method": "session/prompt"}),
            (
                "in",
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": "s-2",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "ok"},
                        },
                    },
                },
            ),
            ("in", {"id": 2, "result": {"stopReason": "end_turn"}}),
        )
    )
    client = _client(project, agent, session_id="old-session")
    from core.agent_clients.base import AgentMessage, ContentBlock

    await client.resume(
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="earlier ask")],
            )
        ]
    )
    async with client:
        await _turn(client)
    assert agent.answers("session/load") == [], "loadSession is false: never called"
    [prompt] = agent.answers("session/prompt")
    assert "earlier ask" in prompt["params"]["prompt"][0]["text"]


async def test_a_mode_that_acts_without_asking_is_put_back(project: Path) -> None:
    def chunk(text: str) -> tuple[str, dict[str, Any]]:
        return (
            "in",
            {
                "method": "session/update",
                "params": {
                    "sessionId": "s-3",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text},
                    },
                },
            },
        )

    agent = FakeAgent(
        _scripted(
            *_INIT,
            ("out", {"id": 1, "method": "session/new"}),
            (
                "in",
                {
                    "id": 1,
                    "result": {
                        "sessionId": "s-3",
                        "modes": {
                            "availableModes": [{"id": "default"}, {"id": "yolo"}],
                            "currentModeId": "default",
                        },
                    },
                },
            ),
            ("out", {"id": 2, "method": "session/prompt"}),
            (
                "in",
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": "s-3",
                        "update": {
                            "sessionUpdate": "current_mode_update",
                            "currentModeId": "yolo",
                        },
                    },
                },
            ),
            chunk("ok"),
            ("in", {"id": 2, "result": {"stopReason": "end_turn"}}),
            ("out", {"id": 3, "method": "session/set_mode"}),
            ("in", {"id": 3, "result": {}}),
        )
    )
    client = _client(project, agent)
    async with client:
        await _turn(client)
        for _ in range(20):
            if agent.answers("session/set_mode"):
                break
            await asyncio.sleep(0)
    [set_mode] = agent.answers("session/set_mode")
    assert set_mode["params"]["modeId"] == "default"


@pytest.mark.parametrize(
    ("stop", "match"),
    [
        ("max_tokens", "output limit"),
        ("refusal", "refused"),
        ("max_turn_requests", "limit of model requests"),
    ],
)
async def test_a_turn_that_did_not_end_is_an_error(
    project: Path, stop: str, match: str
) -> None:
    agent = FakeAgent(
        _scripted(
            *_INIT,
            ("out", {"id": 1, "method": "session/new"}),
            ("in", {"id": 1, "result": {"sessionId": "s-4"}}),
            ("out", {"id": 2, "method": "session/prompt"}),
            ("in", {"id": 2, "result": {"stopReason": stop}}),
        )
    )
    client = _client(project, agent)
    async with client:
        with pytest.raises(AcpError, match=match):
            await _turn(client)


async def test_a_provider_refusal_in_a_prompt_names_the_login(project: Path) -> None:
    agent = FakeAgent(
        _scripted(
            *_INIT,
            ("out", {"id": 1, "method": "session/new"}),
            ("in", {"id": 1, "result": {"sessionId": "s-5"}}),
            ("out", {"id": 2, "method": "session/prompt"}),
            # Gemini's real answer to an invalid key (code 400, Google's body).
            (
                "in",
                {
                    "id": 2,
                    "error": {
                        "code": 400,
                        "message": "API key not valid. Please pass a valid API key.",
                    },
                },
            ),
        )
    )
    client = _client(project, agent)
    async with client:
        with pytest.raises(
            AcpAuthenticationError, match="refused by its provider.*GEMINI_API_KEY"
        ):
            await _turn(client)


async def test_another_protocol_version_is_refused(project: Path) -> None:
    agent = FakeAgent(
        _scripted(
            ("out", {"id": 0, "method": "initialize"}),
            ("in", {"id": 0, "result": {"protocolVersion": 2}}),
        )
    )
    client = _client(project, agent)
    async with client:
        with pytest.raises(AcpError, match="ACP version 2"):
            await _turn(client)


async def test_a_missing_executable_says_where_to_get_it(
    project: Path, monkeypatch
) -> None:
    client = AcpAgentClient(provider="gemini-cli", project_dir=str(project))
    monkeypatch.setattr(client, "_resolve_executable", lambda: None)
    await client.query("hi")
    with pytest.raises(AcpError, match="not installed.*geminicli.com"):
        [m async for m in client.receive_response()]


# ── the agent's writes ────────────────────────────────────────────────────


def test_writes_are_held_to_the_build_roots_and_spare_the_guardrails(
    project: Path, tmp_path: Path
) -> None:
    client = _client(project, FakeAgent([]))
    assert client._write_refusal(str(project / "src" / "a.py")) is None
    assert "outside" in client._write_refusal(str(tmp_path / "elsewhere.txt"))
    assert "absolute" in client._write_refusal("src/a.py")
    assert "security configuration" in client._write_refusal(
        str(project / ".workpilot-allowlist")
    )
    read_only = _client(project, FakeAgent([]), agent_type="spec_critic")
    assert "declares no write" in read_only._write_refusal(
        str(project / "src" / "a.py")
    )


def test_a_link_out_of_the_worktree_is_judged_by_its_target(
    project: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (project / "link").symlink_to(outside, target_is_directory=True)
    client = _client(project, FakeAgent([]))
    assert "outside" in client._write_refusal(str(project / "link" / "x.txt"))


async def test_a_permission_whose_location_leaves_the_roots_is_refused_unasked(
    project: Path, tmp_path: Path
) -> None:
    broker = RecordingBroker("proceed_once")
    client = _client(project, FakeAgent([]), broker=broker)
    client._session = "s"
    answer = await client._permission(
        {
            "sessionId": "s",
            "toolCall": {
                "kind": "edit",
                "title": "Writing",
                "locations": [{"path": str(tmp_path / "x")}],
            },
            "options": [
                {"optionId": "ok", "name": "Allow", "kind": "allow_once"},
                {"optionId": "no", "name": "No", "kind": "reject_once"},
            ],
        }
    )
    assert broker.questions == []
    assert answer == {"outcome": {"outcome": "selected", "optionId": "no"}}


async def test_a_permission_with_no_reject_option_is_cancelled(project: Path) -> None:
    client = _client(project, FakeAgent([]), agent_type="spec_critic")
    client._session = "s"
    answer = await client._permission(
        {
            "sessionId": "s",
            "toolCall": {"kind": "execute", "title": "rm"},
            "options": [{"optionId": "ok", "name": "Allow", "kind": "allow_once"}],
        }
    )
    assert answer == {"outcome": {"outcome": "cancelled"}}


# ── the pieces ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kind", "agent_type", "allowed"),
    [
        ("read", "spec_critic", True),
        ("search", "spec_critic", True),
        ("think", "spec_critic", True),
        ("edit", "spec_critic", False),
        ("execute", "spec_critic", False),
        ("switch_mode", "spec_critic", False),
        ("other", "spec_critic", False),
        ("edit", "architecture_visualizer", True),
        ("execute", "architecture_visualizer", False),
        ("execute", "coder", True),
        ("delete", "coder", True),
        ("execute", "an-unregistered-type", True),
    ],
)
def test_tool_kinds_follow_the_declaration(
    kind: str, agent_type: str, allowed: bool
) -> None:
    assert kind_allowed(kind, agent_type) is allowed


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        (None, None),
        ("default", None),
        ("gemini-2.5-pro", "gemini-2.5-pro"),
        ("google/gemini-2.5-flash", "gemini-2.5-flash"),
        ("claude-sonnet-4-6", None),
    ],
)
def test_the_model_is_one_the_agent_takes(
    model: str | None, expected: str | None
) -> None:
    assert acp_model(model, ("gemini-",), "Gemini CLI") == expected


async def test_the_model_rides_on_its_flag(project: Path) -> None:
    agent = FakeAgent(_fixture("write-rejected", project))
    client = AcpAgentClient(
        provider="gemini-cli",
        model="gemini-2.5-flash",
        project_dir=str(project),
        broker=RecordingBroker("cancel"),
        executable="gemini",
        process_factory=agent,
    )
    async with client:
        await _turn(client)
    assert agent.argv == ("gemini", "--acp", "--model", "gemini-2.5-flash")


async def test_the_agent_process_gets_no_loader_injection_nor_claude_token(
    project: Path, monkeypatch
) -> None:
    monkeypatch.setenv("NODE_OPTIONS", "--require /tmp/evil.js")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-test-0000")
    monkeypatch.setenv("GEMINI_API_KEY", "sk-test-0000")
    agent = FakeAgent(_fixture("write-rejected", project))
    client = _client(project, agent, broker=RecordingBroker("cancel"))
    async with client:
        await _turn(client)
    assert "NODE_OPTIONS" not in agent.env
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in agent.env
    assert agent.env["GEMINI_API_KEY"] == "sk-test-0000"


def test_only_what_the_agent_declares_is_said_to_be_there(project: Path) -> None:
    client = _client(project, FakeAgent([]))
    client.agent_info = {"title": "Gemini CLI", "version": "0.65.0"}
    client.agent_capabilities = {
        "loadSession": True,
        "promptCapabilities": {"image": True, "audio": False},
        "mcpCapabilities": {"http": "yes"},
    }
    summary = client.declared_summary()
    assert summary == "Gemini CLI 0.65.0; declares: session/load, images"
    client.agent_capabilities = {}
    assert client.declared_summary().endswith("declares: nothing beyond prompts")


def test_from_acp_usage() -> None:
    assert from_acp_usage(
        {
            "inputTokens": 240,
            "outputTokens": 18,
            "thoughtTokens": 4,
            "cachedReadTokens": 100,
            "totalTokens": 258,
        }
    ) == CallUsage(prompt=240, cache_read=100, cache_write=None, output=18, reasoning=4)
    assert from_acp_usage({"totalTokens": 5}) is None
    assert from_acp_usage(None) is None


def test_display_text_is_one_bounded_line() -> None:
    assert display_text("a\nb‮\x07 c", 100) == "a b c"
    assert display_text("x" * 50, 10) == "x" * 9 + "…"


# ── the matrix ────────────────────────────────────────────────────────────


def test_gemini_cli_is_an_acp_entry_of_the_matrix() -> None:
    caps = get_provider_capabilities("gemini-cli")
    assert caps.adapter == "AcpAgentClient"
    assert caps.acp is not None
    assert caps.acp.command == ("gemini", "--acp")
    assert caps.acp.read_only_mode == "plan"
    assert not caps.supports_subagents


@pytest.mark.parametrize(
    "block",
    [
        {"command": ["/usr/bin/gemini", "--acp"]},
        {"command": ["gemini", "--acp && rm -rf ~"]},
        {"command": []},
        {"command": ["gemini"], "auth_env": {"key": "lower-case"}},
        "gemini --acp",
    ],
)
def test_a_malformed_acp_block_is_refused_at_load(block: Any) -> None:
    with pytest.raises(ValueError):
        _parse_acp("broken", block)


def test_create_agent_client_routes_gemini_cli(tmp_path: Path) -> None:
    from core.client import create_agent_client

    client = create_agent_client(
        project_dir=tmp_path,
        spec_dir=tmp_path / "spec",
        model="gemini-2.5-pro",
        provider="gemini-cli",
    )
    assert isinstance(client, AcpAgentClient)
    assert client.model == "gemini-2.5-pro"
    assert client.provider_name() == "gemini-cli"


def test_gemini_cli_never_asks_for_the_claude_oauth_token() -> None:
    from core.auth import provider_requires_claude_oauth

    assert provider_requires_claude_oauth("gemini-cli") is False


def test_gemini_cli_phase_default_is_its_own(tmp_path: Path) -> None:
    from phase_config import get_phase_model

    assert get_phase_model(tmp_path, "coding", cli_provider="gemini-cli") == "default"


# ── who answers ───────────────────────────────────────────────────────────


def _question() -> PermissionQuestion:
    return PermissionQuestion(
        agent="Gemini CLI",
        title="Writing to notes/ok.txt",
        kind="edit",
        options=(
            PermissionOption("proceed_once", "Allow", "allow_once"),
            PermissionOption("cancel", "Reject", "reject_once"),
        ),
        locations=("notes/ok.txt",),
        request_id="11111111-1111-4111-8111-111111111111",
    )


class _Pipe(io.RawIOBase):
    """A stdin the test writes answers into, read line by line by the thread."""

    def __init__(self) -> None:
        import queue

        self.lines: queue.Queue[bytes] = queue.Queue()

    def __iter__(self):
        while True:
            line = self.lines.get()
            if not line:
                return
            yield line


async def test_the_app_broker_asks_on_the_card_and_reads_the_answer_from_stdin(
    tmp_path: Path, capsys
) -> None:
    pipe = _Pipe()
    broker = StdinBroker(tmp_path, answers=_StdinAnswers(pipe))
    asked = asyncio.create_task(broker.ask(_question()))
    await asyncio.sleep(0.05)
    # An answer for another request, and one naming no offered option: ignored.
    pipe.lines.put(
        f'{ANSWER_PREFIX}{{"requestId": "other", "optionId": "cancel"}}\n'.encode()
    )
    pipe.lines.put(
        f'{ANSWER_PREFIX}{{"requestId": "{_question().request_id}", "optionId": "yolo"}}\n'.encode()
    )
    pipe.lines.put(b"some other line\n")
    await asyncio.sleep(0.05)
    assert not asked.done()
    pipe.lines.put(
        f'{ANSWER_PREFIX}{{"requestId": "{_question().request_id}", "optionId": "proceed_once"}}\n'.encode()
    )
    assert await asyncio.wait_for(asked, 2) == "proceed_once"
    pipe.lines.put(b"")
    events = [
        json.loads(line.split("__TASK_EVENT__:", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if "__TASK_EVENT__:" in line
    ]
    requested, resolved = events
    assert requested["type"] == "PERMISSION_REQUESTED"
    assert requested["request"]["options"][0] == {
        "optionId": "proceed_once",
        "name": "Allow",
        "kind": "allow_once",
    }
    assert requested["request"]["locations"] == ["notes/ok.txt"]
    assert resolved == {
        **resolved,
        "type": "PERMISSION_RESOLVED",
        "outcome": "answered",
        "optionId": "proceed_once",
    }


async def test_the_app_broker_gives_up_after_its_timeout(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("WORKPILOT_PERMISSION_TIMEOUT_SECONDS", "0.05")
    pipe = _Pipe()
    broker = StdinBroker(tmp_path, answers=_StdinAnswers(pipe))
    assert await broker.ask(_question()) is None
    pipe.lines.put(b"")
    assert '"outcome": "timeout"' in capsys.readouterr().out


def test_the_broker_follows_the_channel(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("WORKPILOT_PERMISSION_CHANNEL", "stdin")
    assert isinstance(broker_for(tmp_path), StdinBroker)
    monkeypatch.delenv("WORKPILOT_PERMISSION_CHANNEL")
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert isinstance(broker_for(tmp_path), UnansweredBroker)


async def test_nobody_to_ask_refuses() -> None:
    assert await UnansweredBroker("no one").ask(_question()) is None
