"""Lot 6: a WorkPilot loop sends one sorted tool set, fixed for the session.

Every provider that caches a prompt caches the tool definitions ahead of the
conversation, so a tool set that moves rewrites the whole cache. The clients
that run their own loop (OpenAI and the compatible providers, Ollama and LM
Studio, Copilot, Windsurf) now prepare their tools once, at session start, in
one canonical form; every turn sends those bytes. And the executor no longer
offers what a type never uses: ``analyze_project``, which nothing could run,
and the brain's and ui-ux's tools to a type that declares no tool at all.
"""

from __future__ import annotations

import asyncio
import json
import logging
from unittest.mock import AsyncMock

import pytest
from agents.tools_pkg.models import AGENT_CONFIGS
from brain.runtime import AGENT_TOOL_NAMES as BRAIN_TOOL_NAMES
from core.agent_client import (
    CopilotAgentClient,
    LocalAgentClient,
    OpenAIAgentClient,
    WindsurfAgentClient,
)
from core.runtimes import tool_executor
from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions
from harness.application.tools import chars_per_token, tool_weights
from harness.domain.tools import ToolSet, canonical_tools
from uiux.mcp_server import TOOL_NAMES as UIUX_TOOL_NAMES

# `json` is the post() keyword below, which shadows the module.
_dumps = json.dumps

TOOLLESS_TYPES = sorted(t for t, c in AGENT_CONFIGS.items() if not c.get("tools"))


def _names(definitions) -> list[str]:
    return [tool["name"] for tool in definitions]


@pytest.fixture
def brain_and_uiux(monkeypatch):
    """A machine with a brain, and a task the ui-ux preflight called a UI task."""

    def fake(names):
        return [
            {"name": name, "description": f"{name}.", "parameters": {}}
            for name in names
        ]

    monkeypatch.setattr(
        tool_executor, "_brain_tool_definitions", lambda: fake(BRAIN_TOOL_NAMES)
    )
    monkeypatch.setattr(
        tool_executor, "_uiux_tool_definitions", lambda spec_dir: fake(UIUX_TOOL_NAMES)
    )


# --- The executor's definitions: sorted, canonical, only what is used ---


@pytest.mark.parametrize("agent_type", [*sorted(AGENT_CONFIGS), "not-a-type"])
def test_every_type_is_offered_its_tools_sorted_and_canonical(
    agent_type, brain_and_uiux
):
    offered = get_tool_definitions(agent_type)
    assert _names(offered) == sorted(_names(offered))
    assert offered == canonical_tools(offered)


@pytest.mark.parametrize("agent_type", TOOLLESS_TYPES)
def test_a_type_that_declares_no_tool_gets_no_brain_and_no_uiux(
    agent_type, brain_and_uiux
):
    """Reading is not guarded, on any provider; the brain and ui-ux follow the
    rule `get_required_mcp_servers` applies on the Claude SDK."""
    assert _names(get_tool_definitions(agent_type)) == ["list_files", "read_file"]


@pytest.mark.parametrize("agent_type", ["coder", "planner", "insights", "not-a-type"])
def test_a_type_with_tools_keeps_the_brain_and_uiux(agent_type, brain_and_uiux):
    offered = set(_names(get_tool_definitions(agent_type)))
    assert set(BRAIN_TOOL_NAMES) | set(UIUX_TOOL_NAMES) <= offered


def test_the_executor_refuses_a_brain_tool_to_a_type_that_declares_no_tool(
    tmp_path, monkeypatch
):
    """Native `tool_calls` are not checked against what was offered: the
    executor is the one gate, so what is no longer offered is refused there."""
    import brain.runtime

    calls: list[str] = []

    async def fake_execute(name, arguments, **kwargs):
        calls.append(name)
        return "written"

    monkeypatch.setattr(brain.runtime, "execute_tool", fake_execute)
    args = {"title": "Choix ORM", "body": "EF Core."}

    refused = ToolExecutor(str(tmp_path), agent_type="commit_message")
    answer = asyncio.run(refused.execute("brain_write_note", args))
    assert "not available to this agent (commit_message)" in answer
    assert calls == []

    allowed = ToolExecutor(str(tmp_path), agent_type="coder")
    assert asyncio.run(allowed.execute("brain_write_note", args)) == "written"
    assert calls == ["brain_write_note"]


@pytest.mark.parametrize("agent_type", ["planner", "spec_writer"])
def test_the_planner_no_longer_carries_a_tool_nothing_runs(agent_type):
    offered = set(_names(get_tool_definitions(agent_type)))
    assert "analyze_project" not in offered
    assert "Write" in offered  # what planner.md asks for stays


# --- What each type weighs: the measure behind the lot's exit criterion ---


def test_the_weights_of_every_type_in_the_gauge_unit(brain_and_uiux):
    from context_mgmt.guard import CHARS_PER_TOKEN

    assert chars_per_token() == CHARS_PER_TOKEN
    weights = tool_weights()
    assert set(weights) == set(AGENT_CONFIGS)
    reading = ToolSet.of(
        tool
        for tool in get_tool_definitions("coder")
        if tool["name"] in ("list_files", "read_file")
    )
    for agent_type, tool_set in weights.items():
        if agent_type in TOOLLESS_TYPES:
            # A type that answers in text pays for reading, and nothing else.
            assert tool_set.fingerprint == reading.fingerprint
        else:
            assert tool_set.tokens(CHARS_PER_TOKEN) > reading.tokens(CHARS_PER_TOKEN)


# --- The clients: prepared once, at session start ---


class _FakeMCP:
    """An MCP bridge whose server lists its tools in a given order."""

    defs: list[dict] = []

    def __init__(self, project_dir, servers):
        pass

    async def connect(self):
        pass

    def tool_definitions(self):
        return list(self.defs)

    def has_tool(self, name):
        return False

    async def aclose(self):
        pass


MCP_DEFS = [
    {
        "name": "mcp__srv__search",
        "description": "Search.",
        "parameters": {
            "type": "object",
            "properties": {"q": {"type": "string"}, "limit": {"type": "integer"}},
        },
    },
    {"name": "mcp__srv__fetch", "description": "Fetch.", "parameters": {}},
]
# The same server another day: tools and schema keys in another order.
MCP_DEFS_REORDERED = [
    {"parameters": {}, "name": "mcp__srv__fetch", "description": "Fetch."},
    {
        "description": "Search.",
        "parameters": {
            "properties": {"limit": {"type": "integer"}, "q": {"type": "string"}},
            "type": "object",
        },
        "name": "mcp__srv__search",
    },
]


async def _openai_session_tools(tmp_path, monkeypatch, defs) -> OpenAIAgentClient:
    import core.mcp_tools

    monkeypatch.setattr(
        core.mcp_tools, "load_mcp_server_configs_for", lambda *a, **k: [{"id": "srv"}]
    )
    monkeypatch.setattr(
        core.mcp_tools, "MCPToolManager", type("Bridge", (_FakeMCP,), {"defs": defs})
    )
    client = OpenAIAgentClient(
        project_dir=str(tmp_path), agent_type="coder", api_key="sk-test-0000"
    )
    async with client:
        return client


@pytest.mark.asyncio
async def test_openai_freezes_its_tools_and_the_bridged_mcp_tools_in_one_order(
    tmp_path, monkeypatch
):
    first = await _openai_session_tools(tmp_path, monkeypatch, MCP_DEFS)
    second = await _openai_session_tools(tmp_path, monkeypatch, MCP_DEFS_REORDERED)

    names = _names(first._tool_definitions)
    assert names == sorted(names)
    assert {"mcp__srv__fetch", "mcp__srv__search", "run_command"} <= set(names)
    assert first.tool_set is not None and second.tool_set is not None
    assert first.tool_set.fingerprint == second.tool_set.fingerprint
    assert _dumps(first._tool_definitions) == _dumps(second._tool_definitions)


@pytest.mark.asyncio
async def test_copilot_freezes_its_tools_at_session_start(tmp_path):
    client = CopilotAgentClient(
        cwd=str(tmp_path), github_token="ghp_test", agent_type="planner"
    )
    async with client:
        assert client.tool_set == ToolSet.of(get_tool_definitions("planner"))
        assert client._tool_definitions == list(client.tool_set.tools)


@pytest.mark.asyncio
async def test_windsurf_freezes_its_tools_at_session_start(tmp_path, monkeypatch):
    import integrations.windsurf_proxy.auth as auth

    monkeypatch.setenv("WINDSURF_API_KEY", "oauth_test-0000")
    monkeypatch.setattr(auth, "is_windsurf_running", lambda: False)
    client = WindsurfAgentClient(
        model="gpt-4o", project_dir=str(tmp_path), agent_type="qa_reviewer"
    )
    async with client:
        assert client.tool_set == ToolSet.of(get_tool_definitions("qa_reviewer"))
        assert client._tool_definitions == list(client.tool_set.tools)


@pytest.mark.asyncio
async def test_a_second_preparation_in_the_session_keeps_the_first_set(
    tmp_path, monkeypatch, caplog
):
    client = CopilotAgentClient(
        cwd=str(tmp_path), github_token="ghp_test", agent_type="coder"
    )
    async with client:
        first = client.tool_set
        sent = _dumps(client._tool_definitions)
    monkeypatch.setattr(
        tool_executor,
        "get_tool_definitions",
        lambda agent_type, spec_dir=None: [{"name": "read_file"}],
    )
    with caplog.at_level(logging.WARNING):
        async with client:
            assert client.tool_set is first
            assert _dumps(client._tool_definitions) == sent
    assert "the session's tools changed" in caplog.text


# --- Every turn sends the same tools (and the same effort) ---


UNSORTED = [
    {"name": "write_file", "parameters": {"type": "object", "properties": {}}},
    {
        "name": "read_file",
        "description": "Read.",
        "parameters": {
            "required": ["path"],
            "properties": {"path": {"type": "string"}},
            "type": "object",
        },
    },
]
READ_CALL = {
    "id": "call_1",
    "function": {"name": "read_file", "arguments": json.dumps({"path": "a.py"})},
}


class _Executor:
    """A result that changes every call: progress, so the loop goes on."""

    def __init__(self):
        self.calls = 0

    async def execute(self, name, args):
        self.calls += 1
        return f"attempt {self.calls}"


class _Response:
    def __init__(self, data):
        self.status = 200
        self._data = data

    async def json(self):
        return self._data

    async def text(self):
        return json.dumps(self._data)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _ChatSession:
    """Answers every chat-completions POST with a tool call; keeps the payloads."""

    def __init__(self):
        self.tools: list[str] = []
        self.efforts: list[str | None] = []

    def post(self, url, json=None, **kwargs):  # noqa: A002 - aiohttp's name
        self.tools.append(_dumps(json.get("tools")))
        self.efforts.append(json.get("reasoning_effort"))
        return _Response(
            {
                "choices": [
                    {
                        "message": {"content": "", "tool_calls": [READ_CALL]},
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        )


def _openai():
    client = OpenAIAgentClient(
        model="gpt-5", api_key="sk-test-0000", max_turns=4, reasoning_effort="high"
    )
    return client


def _copilot():
    client = CopilotAgentClient(github_token="ghp_test", max_turns=4)
    client._get_copilot_token = AsyncMock(return_value="copilot-token")
    return client


def _windsurf_rest():
    client = WindsurfAgentClient(model="gpt-4o", max_turns=4)
    client._use_local_grpc = False
    return client


async def _run(client):
    await client.query("fix it")
    return [msg async for msg in client.receive_response()]


@pytest.mark.asyncio
@pytest.mark.parametrize("make", [_openai, _copilot, _windsurf_rest])
async def test_chat_completion_loops_send_the_same_tools_every_turn(make):
    client = make()
    client._freeze_tools(UNSORTED)
    session = _ChatSession()
    client._http_client = session
    if isinstance(client, CopilotAgentClient):
        client._get_http_client = lambda: session
    client._tool_executor = _Executor()

    await _run(client)

    assert len(session.tools) == 4
    assert len(set(session.tools)) == 1
    assert [t["function"]["name"] for t in json.loads(session.tools[0])] == [
        "read_file",
        "write_file",
    ]
    if isinstance(client, OpenAIAgentClient):
        # The effort is chosen once, when the client is built for the phase.
        assert session.efforts == ["high"] * 4


class _OllamaResponse:
    def __init__(self, line: str):
        self.status = 200
        self._line = line

    async def text(self):
        return ""

    @property
    def content(self):
        async def _iter():
            yield self._line.encode("utf-8")

        return _iter()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _OllamaSession:
    def __init__(self):
        self.tools: list[str] = []

    def post(self, url, json=None, timeout=None, *, allow_redirects=True):  # noqa: A002
        self.tools.append(_dumps(json.get("tools")))
        return _OllamaResponse(
            _dumps(
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "read_file",
                                    "arguments": {"path": "a.py"},
                                }
                            }
                        ],
                    },
                    "done": True,
                }
            )
            + "\n"
        )


@pytest.mark.asyncio
async def test_the_ollama_loop_sends_the_same_tools_every_turn(monkeypatch):
    monkeypatch.setattr(LocalAgentClient, "_loaded_model_placement", lambda self: None)
    client = LocalAgentClient(model="llama3.3", max_turns=4)
    session = _OllamaSession()
    client._http_client = session
    client._model_max_ctx = None
    client._freeze_tools(UNSORTED)
    client._tool_executor = _Executor()

    await _run(client)

    assert len(session.tools) == 4
    assert len(set(session.tools)) == 1


@pytest.mark.asyncio
async def test_the_windsurf_text_mode_sends_the_same_system_every_turn(monkeypatch):
    import integrations.windsurf_proxy.cascade_client as cascade
    import integrations.windsurf_proxy.models as models

    systems: list[str] = []

    async def fake_cascade_chat(*, credentials, messages, model_enum, model_uid):
        systems.append(messages[0]["content"])
        return '<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>'

    monkeypatch.setattr(cascade, "cascade_chat", fake_cascade_chat)
    monkeypatch.setattr(models, "requires_cascade", lambda name: True)

    client = WindsurfAgentClient(model="swe-1.6", max_turns=4)
    client.system_prompt = "You are a coder."
    client._use_local_grpc = True
    client._freeze_tools(UNSORTED)
    client._tool_executor = _Executor()

    await _run(client)

    assert len(systems) == 4
    assert len(set(systems)) == 1
    assert systems[0].index("**read_file**") < systems[0].index("**write_file**")
