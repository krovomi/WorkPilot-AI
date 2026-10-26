"""Spans around a real AgentClient subclass, read from an in-memory exporter."""

from __future__ import annotations

import inspect
import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from core.agent_clients import base as client_base
from core.agent_clients.base import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from genai_trace import tracer as tracer_module
from harness.domain.usage import CallUsage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode

PROMPT = "SECRET-PROMPT refactor the login form"
REPLY = "SECRET-REPLY done"


@pytest.fixture
def spans():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer_module.use_tracer_for_tests(provider.get_tracer("test"))
    yield exporter
    tracer_module.reset()


@pytest.fixture
def tracing_off():
    tracer_module.use_tracer_for_tests(None)
    yield
    tracer_module.reset()


def _assistant(*blocks: ContentBlock) -> AgentMessage:
    return AgentMessage(role=MessageRole.ASSISTANT, content=list(blocks))


class FakeClient(AgentClient):
    """A provider whose script decides what one response contains."""

    model = "fake-model-1"

    def __init__(self, script: list, *, provider: str = "openai") -> None:
        self.script = script
        self._provider = provider
        self.genai_agent = "coder"
        self.genai_spec_id = "001-login"

    async def query(self, prompt: str) -> None:
        self.prompt = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for step in self.script:
            if isinstance(step, CallUsage) or step is None:
                self._record_call(step)
            elif isinstance(step, Exception):
                raise step
            else:
                yield step

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return None

    def supports_subagents(self) -> bool:
        return False

    def provider_name(self) -> str:
        return self._provider


class WrappingClient(FakeClient):
    """An adapter that extends its parent's stream: traced once, not twice."""

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        async for message in super().receive_response():
            yield message


def _usage(prompt: int, output: int, cache_read: int | None = None) -> CallUsage:
    return CallUsage(
        prompt=prompt, cache_read=cache_read, cache_write=None, output=output
    )


async def _run(client: AgentClient, prompt: str = PROMPT) -> list[AgentMessage]:
    await client.query(prompt)
    return [message async for message in client.receive_response()]


def _by_name(exporter: InMemorySpanExporter) -> dict[str, list]:
    found: dict[str, list] = {}
    for span in exporter.get_finished_spans():
        found.setdefault(span.name, []).append(span)
    return found


async def test_one_response_is_an_agent_span_with_its_calls_and_tools(spans) -> None:
    client = FakeClient(
        [
            _usage(1500, 40, cache_read=1000),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="Bash",
                    tool_id="call-1",
                    tool_input={"command": "SECRET-ARG ls"},
                )
            ),
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_RESULT,
                        tool_use_id="call-1",
                        result_content="SECRET-OUTPUT",
                        is_error=True,
                    )
                ],
            ),
            _usage(1700, 60, cache_read=1500),
            _assistant(ContentBlock(type=ContentBlockType.TEXT, text=REPLY)),
        ]
    )
    await _run(client)

    found = _by_name(spans)
    (agent,) = found["invoke_agent coder"]
    chats = found["chat fake-model-1"]
    (tool,) = found["execute_tool Bash"]

    assert agent.attributes["gen_ai.provider.name"] == "openai"
    assert agent.attributes["workpilot.spec_id"] == "001-login"
    assert agent.attributes["gen_ai.usage.input_tokens"] == 3200
    assert agent.attributes["gen_ai.usage.output_tokens"] == 100
    assert agent.attributes["gen_ai.usage.cache_read.input_tokens"] == 2500
    assert agent.attributes["workpilot.usage.source"] == "reported"
    # Never recorded, so never zero.
    assert "gen_ai.usage.cache_creation.input_tokens" not in agent.attributes

    assert len(chats) == 2
    assert [c.attributes["gen_ai.usage.input_tokens"] for c in chats] == [1500, 1700]
    for child in (*chats, tool):
        assert child.parent.span_id == agent.context.span_id
    # The second call starts when the tool result came back.
    assert chats[1].start_time == tool.end_time

    assert tool.attributes["gen_ai.tool.call.id"] == "call-1"
    assert tool.attributes["error.type"] == "tool_error"
    assert tool.status.status_code == StatusCode.ERROR

    every_value = json.dumps(
        [dict(span.attributes) for span in spans.get_finished_spans()]
    )
    assert "SECRET" not in every_value


async def test_unreported_usage_is_estimated_not_zero(spans) -> None:
    client = FakeClient(
        [None, _assistant(ContentBlock(type=ContentBlockType.TEXT, text="x" * 41))],
        provider="copilot",
    )
    await _run(client, prompt="p" * 400)

    found = _by_name(spans)
    (chat,) = found["chat fake-model-1"]
    assert chat.attributes["workpilot.usage.source"] == "unreported"
    assert "gen_ai.usage.input_tokens" not in chat.attributes
    (agent,) = found["invoke_agent coder"]
    assert agent.attributes["workpilot.usage.source"] == "estimated"
    assert agent.attributes["gen_ai.usage.input_tokens"] == 100
    assert agent.attributes["gen_ai.usage.output_tokens"] == 11
    assert client.genai_estimate == {"input_tokens": 100, "output_tokens": 11}


async def test_a_session_total_counts_as_reported(spans) -> None:
    client = FakeClient(
        [_assistant(ContentBlock(type=ContentBlockType.TEXT, text="hi"))]
    )
    client.last_usage = {
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_input_tokens": 90,
    }
    await _run(client)
    (agent,) = _by_name(spans)["invoke_agent coder"]
    assert agent.attributes["workpilot.usage.source"] == "reported"
    assert agent.attributes["gen_ai.usage.input_tokens"] == 100
    assert client.genai_estimate is None


async def test_a_failed_response_says_so(spans) -> None:
    client = FakeClient([_usage(10, 1), RuntimeError("SECRET-MESSAGE")])
    with pytest.raises(RuntimeError):
        await _run(client)
    (agent,) = _by_name(spans)["invoke_agent coder"]
    assert agent.status.status_code == StatusCode.ERROR
    assert agent.attributes["error.type"] == "RuntimeError"
    assert "SECRET" not in json.dumps(dict(agent.attributes))


async def test_a_reader_that_stops_early_is_not_a_failure(spans) -> None:
    client = FakeClient(
        [
            _assistant(ContentBlock(type=ContentBlockType.TEXT, text="a")),
            _assistant(ContentBlock(type=ContentBlockType.TEXT, text="b")),
        ]
    )
    await client.query(PROMPT)
    stream = client.receive_response()
    async for _ in stream:
        break
    await stream.aclose()
    (agent,) = _by_name(spans)["invoke_agent coder"]
    assert agent.status.status_code != StatusCode.ERROR


async def test_an_adapter_calling_its_parent_is_traced_once(spans) -> None:
    client = WrappingClient([_usage(10, 1), _assistant()])
    await _run(client)
    found = _by_name(spans)
    assert len(found["invoke_agent coder"]) == 1
    assert len(found["chat fake-model-1"]) == 1


async def test_a_sub_agent_response_nests_under_its_parent(spans) -> None:
    child = FakeClient([_usage(5, 1)])
    child.genai_agent = "researcher"

    class Parent(FakeClient):
        async def receive_response(self) -> AsyncIterator[AgentMessage]:
            await child.query("sub")
            async for _ in child.receive_response():
                pass
            self._record_call(_usage(20, 2))
            yield _assistant()

    await _run(Parent([]))
    found = _by_name(spans)
    (parent,) = found["invoke_agent coder"]
    (sub,) = found["invoke_agent researcher"]
    assert sub.parent.span_id == parent.context.span_id
    chats = found["chat fake-model-1"]
    assert {c.parent.span_id for c in chats} == {
        parent.context.span_id,
        sub.context.span_id,
    }


async def test_tracing_off_still_estimates(tracing_off) -> None:
    client = FakeClient(
        [_assistant(ContentBlock(type=ContentBlockType.TEXT, text="abcd"))]
    )
    await _run(client, prompt="12345678")
    assert client.genai_estimate == {"input_tokens": 2, "output_tokens": 1}


def test_every_real_client_is_wrapped() -> None:
    import core.agent_clients as package

    for module_info in __import__("pkgutil").iter_modules(package.__path__):
        try:
            __import__(f"core.agent_clients.{module_info.name}")
        except ImportError:
            continue
    pending = list(AgentClient.__subclasses__())
    seen = set()
    while pending:
        cls = pending.pop()
        if cls in seen:
            continue
        seen.add(cls)
        pending.extend(cls.__subclasses__())
        own = cls.__dict__.get("receive_response")
        if own is None:
            continue
        assert getattr(own, "__genai_traced__", False), cls
        assert inspect.isasyncgenfunction(inspect.unwrap(own)), cls
    assert len(seen) > 5
    assert client_base.AgentClient.receive_response.__isabstractmethod__


def test_record_client_usage_writes_the_estimate_with_its_source(
    tmp_path: Path,
) -> None:
    from agents.session import record_client_usage

    spec_dir = tmp_path / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    client = FakeClient([], provider="copilot")
    client.genai_estimate = {"input_tokens": 120, "output_tokens": 30}
    record_client_usage(client, spec_dir, "coding", agent_type="coder")

    data = json.loads(
        (tmp_path / ".workpilot" / "cost_data.json").read_text(encoding="utf-8")
    )
    (record,) = data["usages"]
    assert record["usage_source"] == "estimated"
    assert record["input_tokens"] == 120
    assert record["output_tokens"] == 30


def test_record_client_usage_marks_reported_usage(tmp_path: Path) -> None:
    from agents.session import record_client_usage

    spec_dir = tmp_path / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    client = FakeClient([])
    client.last_usage = {"input_tokens": 7, "output_tokens": 3}
    record_client_usage(client, spec_dir, "coding")
    data = json.loads(
        (tmp_path / ".workpilot" / "cost_data.json").read_text(encoding="utf-8")
    )
    assert data["usages"][0]["usage_source"] == "reported"
