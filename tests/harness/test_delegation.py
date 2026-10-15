"""Delegation on the providers that run the WorkPilot loop.

The roster used to be composed for every provider and handed to the model on
Claude alone. These tests pin the other route: the ``delegate`` tool the loop
offers, the child session that runs one delegation with the specialist's
tools and nothing else, the bounded result on the parent's ledger, and the
wave of delegations a turn runs together.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from core.agent_clients.base import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    LoopAdapter,
    MessageRole,
    SubagentDefinition,
)
from harness.application.delegation import run_delegation
from harness.application.loop import run_turns
from harness.domain import UsageLedger
from harness.domain.delegation import (
    CHILD_MAX_TURNS,
    DELEGATE_TOOL,
    child_system_prompt,
    delegate_tool_definition,
    executor_tools,
    is_delegation,
)
from harness.domain.subagents import CONTRACT_HEADING
from harness.domain.usage import CallUsage
from harness.ports import Outcome, Reply, ToolCall, ToolResult

# ── domain ───────────────────────────────────────────────────────────────────


class TestExecutorTools:
    def test_registry_vocabulary_is_translated(self):
        assert executor_tools(["Read", "Grep", "Glob"]) == {
            "read_file",
            "list_files",
            "search_files",
            "find_files",
        }

    def test_bash_and_write(self):
        assert executor_tools(["Bash", "Write"]) == {
            "run_command",
            "write_file",
            "create_directory",
        }

    def test_an_unknown_name_is_dropped_not_passed_through(self):
        # The executor would answer "Unknown tool" to every call of it.
        assert executor_tools(["WebFetch", "Agent"]) == frozenset()

    def test_executor_names_pass_through(self):
        assert executor_tools(["read_file", "search_code"]) == {
            "read_file",
            "search_code",
        }


class TestDelegateTool:
    def test_one_tool_whose_description_lists_the_roster(self):
        tool = delegate_tool_definition(
            {
                "test-runner": SubagentDefinition("Runs the tests.", "..."),
                "code-reviewer": {"description": "Reads a diff.", "prompt": "..."},
            }
        )
        assert tool["name"] == DELEGATE_TOOL
        assert "- code-reviewer: Reads a diff." in tool["description"]
        assert "- test-runner: Runs the tests." in tool["description"]
        assert tool["parameters"]["properties"]["agent"]["enum"] == [
            "code-reviewer",
            "test-runner",
        ]
        assert tool["parameters"]["required"] == ["agent", "task"]

    def test_the_child_prompt_carries_the_contract_once(self):
        prompt = child_system_prompt("You run tests.", project_dir="/p")
        assert prompt.count(CONTRACT_HEADING) == 1
        assert "You run tests." in prompt
        assert "/p" in prompt
        assert "cannot delegate" in prompt

    def test_is_delegation(self):
        assert is_delegation("delegate")
        assert not is_delegation("run_command")


# ── a client double ──────────────────────────────────────────────────────────


class _Executor:
    def __init__(self) -> None:
        self.allowed_tools: frozenset[str] | None = None


class FakeClient(AgentClient):
    """The shape every loop client has, and a scripted child response."""

    def __init__(self, *, replies: list[str] | None = None, fail: bool = False):
        self.model = "m"
        self.system_prompt = "parent prompt"
        self.max_turns = 50
        self._project_dir = "/project"
        self._spec_dir = None
        self._pending_query: str | None = None
        self._tool_executor: Any = None
        self._mcp_manager: Any = None
        self._http_client: Any = None
        self._tool_definitions: list[dict[str, Any]] = []
        self.usage_ledger = None
        self.tool_set = None
        self.agents = {}
        self.replies = replies or []
        self.fail = fail
        self.entered: list[FakeClient] = []

    def delegates(self) -> bool:
        return True

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "fake"

    async def __aenter__(self):
        self.entered.append(self)
        self._tool_executor = _Executor()
        self._freeze_tools(
            [
                {"name": "read_file", "parameters": {}},
                {"name": "run_command", "parameters": {}},
                {"name": "write_file", "parameters": {}},
            ]
        )
        return self

    async def __aexit__(self, *exc):
        return None

    async def query(self, prompt: str) -> None:
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        self._start_usage_ledger()
        if self.fail:
            raise RuntimeError("boom")
        for text in self.replies:
            self._record_call(
                CallUsage(prompt=10, cache_read=None, cache_write=None, output=5)
            )
            yield AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
            )


def _roster() -> dict[str, SubagentDefinition]:
    return {
        "test-runner": SubagentDefinition(
            "Runs the tests.", "You run the tests.", tools=["Bash", "Read"]
        ),
        "code-reviewer": SubagentDefinition(
            "Reads a diff.", "You review.", tools=["Read", "Grep"], model="sonnet"
        ),
    }


class TestFreezeTools:
    @pytest.mark.asyncio
    async def test_a_session_with_a_roster_offers_delegate(self):
        client = FakeClient()
        client.agents = _roster()
        async with client:
            names = {t["name"] for t in client._tool_definitions}
        assert DELEGATE_TOOL in names

    @pytest.mark.asyncio
    async def test_a_session_without_one_does_not(self):
        client = FakeClient()
        async with client:
            names = {t["name"] for t in client._tool_definitions}
        assert DELEGATE_TOOL not in names


class TestRunDelegation:
    @pytest.mark.asyncio
    async def test_the_child_runs_the_role_with_its_tools_only(self):
        parent = FakeClient(
            replies=[
                "working...",
                '{"conclusion": "3 passed", "files": [], "evidence": []}',
            ]
        )
        parent.agents = _roster()
        parent._start_usage_ledger()

        result = await run_delegation(
            parent, {"agent": "test-runner", "task": "Run pytest -x"}
        )

        child = parent.entered[0]
        assert child is not parent
        assert child._pending_query == "Run pytest -x"
        assert child.max_turns == CHILD_MAX_TURNS
        assert child.agents == {}
        assert "You run the tests." in child.system_prompt
        assert CONTRACT_HEADING in child.system_prompt
        # Bash + Read, in the executor's vocabulary, and no `delegate`.
        assert child._tool_executor.allowed_tools == {
            "run_command",
            "read_file",
            "list_files",
        }
        assert {t["name"] for t in child._tool_definitions} == {
            "run_command",
            "read_file",
        }
        # The last message is the result, delimited as data and under the cap.
        assert "3 passed" in result
        assert "working..." not in result

    @pytest.mark.asyncio
    async def test_the_childs_calls_land_on_the_parents_ledger(self):
        parent = FakeClient(replies=["a", "b"])
        parent.agents = _roster()
        parent._start_usage_ledger()
        await run_delegation(parent, {"agent": "test-runner", "task": "t"})
        assert len(parent.usage_ledger.calls) == 2
        assert len(parent.usage_ledger.returns) == 1

    @pytest.mark.asyncio
    async def test_a_model_hint_overrides_the_parents(self):
        parent = FakeClient(replies=["ok"])
        parent.agents = _roster()
        await run_delegation(parent, {"agent": "code-reviewer", "task": "t"})
        assert parent.entered[0].model == "sonnet"
        assert parent.model == "m"

    @pytest.mark.asyncio
    async def test_an_unknown_specialist_is_a_result_not_an_error(self):
        parent = FakeClient()
        parent.agents = _roster()
        result = await run_delegation(parent, {"agent": "nobody", "task": "t"})
        assert "No specialist named 'nobody'" in result
        assert "code-reviewer, test-runner" in result
        assert parent.entered == []

    @pytest.mark.asyncio
    async def test_a_failing_child_is_a_result_too(self):
        parent = FakeClient(fail=True)
        parent.agents = _roster()
        result = await run_delegation(parent, {"agent": "test-runner", "task": "t"})
        assert "failed" in result and "boom" in result

    @pytest.mark.asyncio
    async def test_an_empty_task_is_refused(self):
        parent = FakeClient()
        parent.agents = _roster()
        result = await run_delegation(parent, {"agent": "test-runner", "task": " "})
        assert "no task" in result
        assert parent.entered == []


class TestRunToolIntercept:
    @pytest.mark.asyncio
    async def test_delegate_goes_to_the_child_not_the_executor(self):
        parent = FakeClient(replies=["done"])
        parent.agents = _roster()
        adapter = LoopAdapter(parent, [])
        result = await adapter.run_tool(
            ToolCall("1", DELEGATE_TOOL, {"agent": "test-runner", "task": "t"})
        )
        assert not result.is_error
        assert "done" in result.text

    @pytest.mark.asyncio
    async def test_a_child_cannot_delegate_in_turn(self):
        parent = FakeClient(replies=["done"])
        parent.agents = _roster()
        child = parent.spawn_child()
        child.delegation_scope = frozenset({"read_file"})
        adapter = LoopAdapter(child, [])
        result = await adapter.run_tool(
            ToolCall("1", DELEGATE_TOOL, {"agent": "test-runner", "task": "t"})
        )
        assert result.is_error
        assert "No specialist" in result.text


# ── the loop: a wave ─────────────────────────────────────────────────────────


class _WavePort:
    """A port whose first reply asks for two delegations and a read."""

    provider = "fake"

    def __init__(self) -> None:
        self.turn = 0
        self.running = 0
        self.peak = 0
        self.order: list[str] = []
        self.reinjected: list[tuple[ToolCall, ToolResult]] = []

    def assemble(self, turn: int) -> Any:
        return turn

    async def call(self, request: Any, turn: int) -> AsyncIterator[Any]:
        if turn == 0:
            yield Reply(
                "",
                (
                    ToolCall("a", DELEGATE_TOOL, {"agent": "x", "task": "1"}),
                    ToolCall("b", "read_file", {"path": "p"}),
                    ToolCall("c", DELEGATE_TOOL, {"agent": "y", "task": "2"}),
                ),
            )
        else:
            yield Reply("final")

    def settle(self, reply: Reply, turn: int) -> tuple[list[Any], Outcome]:
        return [], Outcome.DONE

    def announce(self, call: ToolCall, turn: int) -> None:
        self.order.append(f"announce:{call.id}")

    async def execute(self, call: ToolCall) -> ToolResult:
        if is_delegation(call.name):
            self.running += 1
            self.peak = max(self.peak, self.running)
            await asyncio.sleep(0.01)
            self.running -= 1
        return ToolResult(f"result:{call.id}")

    def reinject(self, reply: Reply, results) -> None:
        self.reinjected = list(zip(reply.calls, results, strict=True))

    def remind(self, text: str) -> None: ...
    def clear(self) -> None: ...
    def finish(self, reason) -> None: ...
    def text(self, text: str) -> Any:
        return ("text", text)

    def notice(self, text: str) -> Any:
        return ("notice", text)

    def tool_use(self, call: ToolCall) -> Any:
        return ("use", call.id)

    def tool_result(self, call: ToolCall, result: ToolResult) -> Any:
        return ("result", call.id, result.text)


class TestWave:
    @pytest.mark.asyncio
    async def test_delegations_of_one_turn_run_together_and_report_in_order(self):
        port = _WavePort()
        events = [e async for e in run_turns(port, max_turns=5, ledger=UsageLedger())]
        assert port.peak == 2, "the two delegations did not overlap"
        # Results are reinjected in the order asked, the read included.
        assert [c.id for c, _ in port.reinjected] == ["a", "b", "c"]
        assert [r.text for _, r in port.reinjected] == [
            "result:a",
            "result:b",
            "result:c",
        ]
        # The wave is announced before the read, which follows it.
        assert port.order == ["announce:a", "announce:c", "announce:b"]
        assert ("result", "b", "result:b") in events
        assert ("text", "final") in events
