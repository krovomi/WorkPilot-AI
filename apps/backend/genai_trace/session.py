"""Spans around every AgentClient response: the agent, its model calls, its tools.

``AgentClient.__init_subclass__`` wraps each client's ``receive_response`` with
:func:`traced_response`, so every provider driven through an AgentClient
(Copilot, OpenAI and the OpenAI-style loops, Gemini, Ollama, OpenCode,
Antigravity, pi, Windsurf, Claude through its wrapper) gets the same three
spans without a line in its adapter:

* ``invoke_agent <agent>`` for the response, from the first message to the last;
* ``chat <model>`` for each model call the client records
  (``AgentClient._record_call``, the harness loop's ``Measured`` events);
* ``execute_tool <tool>`` from a tool_use block to its tool_result.

A model call is recorded when it ends, so its span starts at the previous
activity of the response (its start, the previous call, the last tool result):
in an agent loop that is when the request left.

The counts are kept even when tracing is off: a response whose provider
reported no usage leaves ``client.genai_estimate`` (tokens read from
characters), which ``agents.session.record_client_usage`` writes to the cost
data as ``"estimated"`` instead of dropping the session.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from . import attributes as attrs
from .tracer import get_tracer

logger = logging.getLogger(__name__)

_current: contextvars.ContextVar[AgentTrace | None] = contextvars.ContextVar(
    "genai_trace_current", default=None
)


@dataclass(frozen=True)
class _Totals:
    prompt: int | None
    output: int | None
    cache_read: int | None
    cache_write: int | None


def _now() -> int:
    return time.time_ns()


class AgentTrace:
    """One response of one client. Never raises."""

    def __init__(self, client: Any, tracer: Any, parent: AgentTrace | None) -> None:
        self.client = client
        self.tracer = tracer
        self.provider = _safe(lambda: client.provider_name(), "unknown")
        self.model = _safe(lambda: str(getattr(client, "model", "") or ""), "")
        # Set by core.client.create_agent_client: the agent type is the phase's
        # agent (planner, coder, qa_reviewer…), the spec folder names the task.
        agent = str(getattr(client, "genai_agent", None) or self.provider)
        spec_id = getattr(client, "genai_spec_id", None)
        self.prompt_chars = int(getattr(client, "_genai_prompt_chars", 0) or 0)
        self.output_chars = 0
        self.reported_calls = 0
        self.last_activity = _now()
        self.span = None
        self._tools: dict[str, Any] = {}
        self._tool_order: list[str] = []
        # Sums of what the calls reported; None while no call gave that number.
        self._totals: dict[str, int | None] = dict.fromkeys(
            ("prompt", "output", "cache_read", "cache_write")
        )
        if tracer is None:
            return
        try:
            from opentelemetry import trace

            context = (
                trace.set_span_in_context(parent.span)
                if parent is not None and parent.span is not None
                else None
            )
            self.span = tracer.start_span(
                f"invoke_agent {agent}",
                context=context,
                kind=trace.SpanKind.INTERNAL,
                attributes=attrs.agent_attributes(
                    provider=self.provider,
                    model=self.model,
                    agent=agent,
                    spec_id=spec_id,
                ),
                start_time=self.last_activity,
            )
        except Exception as error:  # noqa: BLE001 - tracing never stops a build
            logger.debug("[genai_trace] invoke_agent span failed: %s", error)
            self.span = None

    # -- what the response carries -------------------------------------------

    def observe(self, message: Any) -> None:
        try:
            for block in getattr(message, "content", None) or ():
                kind = getattr(getattr(block, "type", None), "value", None)
                if kind == "text":
                    self.output_chars += len(getattr(block, "text", None) or "")
                elif kind == "tool_use":
                    self._tool_start(block)
                elif kind == "tool_result":
                    self._tool_end(block)
        except Exception as error:  # noqa: BLE001
            logger.debug("[genai_trace] observe failed: %s", error)

    def _child(self, name: str, attributes: dict, start: int) -> Any:
        if self.tracer is None or self.span is None:
            return None
        from opentelemetry import trace

        return self.tracer.start_span(
            name,
            context=trace.set_span_in_context(self.span),
            kind=trace.SpanKind.INTERNAL,
            attributes=attributes,
            start_time=start,
        )

    def _tool_start(self, block: Any) -> None:
        name = getattr(block, "tool_name", None) or "unknown"
        call_id = getattr(block, "tool_id", None) or f"#{len(self._tool_order)}"
        now = _now()
        self.last_activity = now
        span = self._child(
            f"execute_tool {name}", attrs.tool_attributes(name, call_id), now
        )
        self._tools[call_id] = span
        self._tool_order.append(call_id)

    def _tool_end(self, block: Any) -> None:
        call_id = getattr(block, "tool_use_id", None)
        if call_id not in self._tools:
            # A provider that does not echo the id: the oldest open call.
            call_id = next((c for c in self._tool_order if c in self._tools), None)
        now = _now()
        self.last_activity = now
        if call_id is None:
            return
        span = self._tools.pop(call_id)
        if span is None:
            return
        if getattr(block, "is_error", False):
            from opentelemetry.trace import Status, StatusCode

            span.set_attribute("error.type", "tool_error")
            span.set_status(Status(StatusCode.ERROR))
        span.end(end_time=now)

    def model_call(self, usage: Any, thread: str | None) -> None:
        now = _now()
        start, self.last_activity = self.last_activity, now
        if usage is not None and (usage.prompt is not None or usage.output is not None):
            self.reported_calls += 1
            for key in self._totals:
                value = getattr(usage, key, None)
                if value is not None:
                    self._totals[key] = (self._totals[key] or 0) + value
        try:
            span = self._child(
                f"chat {self.model or self.provider}",
                {
                    **attrs.chat_attributes(
                        provider=self.provider, model=self.model, thread=thread
                    ),
                    **attrs.usage_attributes(usage),
                },
                start,
            )
            if span is not None:
                span.end(end_time=now)
        except Exception as error:  # noqa: BLE001
            logger.debug("[genai_trace] chat span failed: %s", error)

    # -- the end ---------------------------------------------------------------

    def _from_last_usage(self) -> bool:
        """A client that keeps only a session total (``last_usage``), no calls."""
        last = getattr(self.client, "last_usage", None)
        if not isinstance(last, dict):
            return False
        counts = {
            key: last.get(key)
            for key in (
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            )
        }
        if not any(isinstance(v, int) and v > 0 for v in counts.values()):
            return False
        read = counts["cache_read_input_tokens"]
        write = counts["cache_creation_input_tokens"]
        self._totals = {
            # The tracker's sense: input_tokens is the uncached part.
            "prompt": sum(
                v for v in (counts["input_tokens"], read, write) if isinstance(v, int)
            ),
            "output": counts["output_tokens"]
            if isinstance(counts["output_tokens"], int)
            else None,
            "cache_read": read if isinstance(read, int) else None,
            "cache_write": write if isinstance(write, int) else None,
        }
        return True

    def finish(self, error: BaseException | None) -> None:
        estimate = None
        if self.reported_calls == 0 and not self._from_last_usage():
            estimate = {
                "input_tokens": attrs.estimate_tokens(self.prompt_chars),
                "output_tokens": attrs.estimate_tokens(self.output_chars),
            }
        try:
            self.client.genai_estimate = estimate
        except Exception:  # noqa: BLE001 - a client with __slots__ keeps none
            pass
        if self.span is None:
            return
        try:
            now = _now()
            for call_id, span in list(self._tools.items()):
                if span is not None:
                    span.set_attribute("workpilot.tool.unfinished", True)
                    span.end(end_time=now)
                self._tools.pop(call_id, None)
            if estimate is not None:
                usage = attrs.estimated_usage(self.prompt_chars, self.output_chars)
            else:
                usage = attrs.usage_attributes(_Totals(**self._totals))
            self.span.set_attributes(usage)
            if error is not None:
                from opentelemetry.trace import Status, StatusCode

                kind = (
                    "cancelled"
                    if isinstance(error, asyncio.CancelledError)
                    else type(error).__name__
                )
                self.span.set_attribute("error.type", kind)
                self.span.set_status(Status(StatusCode.ERROR))
            self.span.end(end_time=now)
        except Exception as failure:  # noqa: BLE001
            logger.debug("[genai_trace] invoke_agent end failed: %s", failure)


def model_call(usage: Any, thread: str | None = None) -> None:
    """A model call of the current response ended. No-op outside one."""
    trace = _current.get()
    if trace is not None:
        trace.model_call(usage, thread)


def note_prompt(client: Any, prompt: Any) -> None:
    """Remember the prompt's size (never its text) for an estimate."""
    try:
        client._genai_prompt_chars = len(prompt) if isinstance(prompt, str) else 0
    except Exception:  # noqa: BLE001
        pass


def traced_query(query: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap ``AgentClient.query``: note the prompt's size."""

    @functools.wraps(query)
    async def wrapper(self: Any, prompt: Any, *args: Any, **kwargs: Any) -> Any:
        note_prompt(self, prompt)
        return await query(self, prompt, *args, **kwargs)

    wrapper.__genai_traced__ = True  # type: ignore[attr-defined]
    return wrapper


def traced_response(receive: Callable[..., AsyncIterator[Any]]) -> Callable[..., Any]:
    """Wrap ``AgentClient.receive_response``: one ``invoke_agent`` span."""

    @functools.wraps(receive)
    async def wrapper(self: Any, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        inner = receive(self, *args, **kwargs)
        if getattr(self, "_genai_active", False):
            # A subclass calling super().receive_response(): already traced.
            async with aclosing(inner):
                async for message in inner:
                    yield message
            return
        parent = _current.get()
        trace = AgentTrace(self, get_tracer(), parent)
        token = _current.set(trace)
        self._genai_active = True
        error: BaseException | None = None
        try:
            async with aclosing(inner):
                async for message in inner:
                    trace.observe(message)
                    yield message
        except GeneratorExit:
            # The reader stopped early (it had what it needed): not a failure.
            raise
        except BaseException as failure:
            error = failure
            raise
        finally:
            self._genai_active = False
            trace.finish(error)
            try:
                _current.reset(token)
            except ValueError:
                # Closed from another context (garbage collection): restore by hand.
                _current.set(parent)

    wrapper.__genai_traced__ = True  # type: ignore[attr-defined]
    return wrapper


def _safe(read: Callable[[], Any], default: Any) -> Any:
    try:
        return read()
    except Exception:  # noqa: BLE001
        return default
