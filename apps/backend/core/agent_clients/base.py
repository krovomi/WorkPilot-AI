"""The provider-agnostic contract every agent client speaks: messages,
content blocks, subagent definitions, the `AgentClient` ABC, the helpers
several providers share (environment parsing, Retry-After, output nudges),
and `LoopAdapter`, the base of every adapter of the shared WorkPilot loop.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

import copy
import logging
import os
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC
from enum import Enum
from typing import Any

from harness.domain import CallUsage, UsageLedger
from harness.domain.stop import StopReason
from harness.domain.subagents import SubagentReturn
from harness.domain.tools import ToolSet
from harness.ports import ToolCall, ToolResult

# Common token-optimization trunk shared by every WorkPilot loop: over-budget
# history compaction. The module is importable under both package layouts.
try:
    from core.llm_optimization import compact_messages
except ImportError:  # pragma: no cover - alternate package layout
    from apps.backend.core.llm_optimization import compact_messages

# The name the monolith logged under, kept so logging configuration and log
# filters keyed on it still match: `core.agent_client`, or
# `apps.backend.core.agent_client` under the repo-root layout.
logger = logging.getLogger(__name__.rpartition(".agent_clients.")[0] + ".agent_client")


def _env_flag(name: str, default: bool) -> bool:
    """Read a boolean tunable from the environment, falling back to ``default``.

    Accepts the shapes users actually type (``0``/``1``, ``false``/``true``,
    ``no``/``yes``, ``off``/``on``); anything else keeps the default rather
    than silently reading as false.
    """
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return default


def _env_float(name: str, default: float) -> float:
    """Read a float tunable from the environment, falling back to ``default``.

    Lets operators widen the Copilot HTTP timeouts for slow/reasoning models
    without editing code (e.g. ``COPILOT_REQUEST_TOTAL_TIMEOUT=900``).
    """
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "[CopilotAgentClient] Invalid %s=%r — using %.0f", name, raw, default
        )
        return default


def _parse_retry_after(headers: object, cap_seconds: float) -> float | None:
    """Extract a wait time (seconds) from an HTTP ``Retry-After`` header.

    GitHub Copilot (and most APIs) return ``Retry-After`` on a 429 to say how
    long to wait before retrying. It can be either an integer number of seconds
    or an HTTP-date. We support both, clamp the result to ``[0, cap_seconds]``,
    and return ``None`` when the header is absent or unparseable so the caller
    can fall back to exponential back-off.
    """
    if headers is None:
        return None
    try:
        raw = headers.get("Retry-After") or headers.get("retry-after")
    except AttributeError:
        return None
    if not raw:
        return None
    raw = str(raw).strip()

    # Shape 1: delta in seconds (e.g. "Retry-After: 30").
    try:
        seconds = float(raw)
        return max(0.0, min(seconds, cap_seconds))
    except (TypeError, ValueError):
        pass

    # Shape 2: HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
    try:
        from email.utils import parsedate_to_datetime

        reset_dt = parsedate_to_datetime(raw)
        if reset_dt is None:
            return None
        from datetime import datetime

        now = datetime.now(reset_dt.tzinfo or UTC)
        seconds = (reset_dt - now).total_seconds()
        return max(0.0, min(seconds, cap_seconds))
    except (TypeError, ValueError, OverflowError):
        return None


# =============================================================================
# Constants
# =============================================================================

CONTENT_TYPE_JSON = "application/json"


# Planner/spec_writer sessions MUST finish by writing their output file
# (`_REQUIRED_OUTPUT_FILE`) via the Write tool. On large brownfield codebases
# the model can burn its whole turn budget on investigation (run_command /
# read_file / list_files) and never write the plan, making the planning phase
# fail with "Did not create plan file". When this many turns (or fewer) remain
# and the Write tool is still unused, we inject a one-time directive forcing the
# model to stop exploring and produce the file now.
_WRITE_NUDGE_TURNS_REMAINING = 8
# Tool names that satisfy the "produced the required output file" condition.
_FILE_WRITE_TOOL_NAMES = ("Write", "write_file")
# The sessions the nudges are for, and the file each must end by writing. They
# used to fire for any session offered a write tool, and named the plan: a
# coder or a QA fixer short of turns was told to write "implementation_plan.json
# … with the COMPLETE JSON content" over the plan it was executing. The planner
# has one output. `spec_writer` runs several prompts — `spec_writer.md` ends in
# spec.md, `planner.md` and `spec_quick.md` in the plan, `complexity_assessor.md`
# in its assessment — so its nudge points at the instructions instead of
# guessing a name.
_REQUIRED_OUTPUT_FILE: dict[str, str | None] = {
    "planner": "implementation_plan.json",
    "spec_writer": None,
}


def _required_output(agent_type: str | None) -> tuple[bool, str]:
    """Whether a session of `agent_type` must end by writing a file, and how
    a nudge names it."""
    if agent_type not in _REQUIRED_OUTPUT_FILE:
        return False, ""
    name = _REQUIRED_OUTPUT_FILE[agent_type]
    return True, (
        f"the required output file ({name})"
        if name
        else "the output file your instructions require"
    )


# =============================================================================
# Message Types for provider-agnostic stream processing
# =============================================================================


class MessageRole(str, Enum):
    """Role of a message in the agent conversation."""

    ASSISTANT = "assistant"
    USER = "user"
    SYSTEM = "system"


class ContentBlockType(str, Enum):
    """Type of content block within a message."""

    TEXT = "text"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    THINKING = "thinking"
    STRUCTURED_OUTPUT = "structured_output"
    RESULT = "result"


@dataclass
class ContentBlock:
    """A single content block within an agent message.

    This normalizes the various block types from different providers
    into a common structure.
    """

    type: ContentBlockType
    text: str | None = None
    # Tool use fields
    tool_name: str | None = None
    tool_id: str | None = None
    tool_input: dict[str, Any] | None = None
    # Tool result fields
    tool_use_id: str | None = None
    is_error: bool = False
    result_content: Any = None
    # Structured output
    structured_output: dict[str, Any] | None = None
    # Result message fields
    subtype: str | None = None


@dataclass
class AgentMessage:
    """A normalized message from the agent stream.

    Wraps messages from any provider (Claude SDK, Copilot API) into
    a common format that process_agent_stream() can handle uniformly.
    """

    role: MessageRole
    content: list[ContentBlock] = field(default_factory=list)
    # Pass through the raw provider message for backward compatibility
    raw: Any = None

    @property
    def type_name(self) -> str:
        """Return a type name compatible with existing SDK message type checks."""
        if self.raw is not None:
            return type(self.raw).__name__
        return f"{self.role.value.capitalize()}Message"


@dataclass
class SubagentDefinition:
    """Provider-agnostic definition of a sub-agent.

    For Claude SDK, this maps to claude_agent_sdk.AgentDefinition.
    For Copilot, this maps to a parallel API session configuration.
    """

    description: str
    prompt: str
    tools: list[str] = field(default_factory=list)
    model: str = "inherit"


# =============================================================================
# Abstract Agent Client
# =============================================================================


class AgentClient(ABC):
    """Abstract interface for an agent execution client.

    Implementations must support:
    - Sending queries to the agent
    - Receiving streamed responses as AgentMessage objects
    - Async context manager protocol for resource lifecycle
    - Declaring sub-agent support capability
    """

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Trace every client the same way (``genai_trace``).

        Each subclass's own ``query`` and ``receive_response`` are wrapped once,
        here, so a new adapter is traced without a line of its own: one
        ``invoke_agent`` span per response, its tools, and the model calls it
        records through :meth:`_record_call`. Off unless an OTLP endpoint is
        set; the prompt's size is noted either way, for an estimate.
        """
        super().__init_subclass__(**kwargs)
        from genai_trace.session import traced_query, traced_response

        own = cls.__dict__
        if "query" in own and not getattr(own["query"], "__genai_traced__", False):
            cls.query = traced_query(own["query"])
        receive = own.get("receive_response")
        if receive is not None and not getattr(receive, "__genai_traced__", False):
            cls.receive_response = traced_response(receive)

    @abstractmethod
    async def query(self, prompt: str) -> None:
        """Send a prompt/query to the agent.

        Args:
            prompt: The user message to send to the agent.
        """
        ...

    @abstractmethod
    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Receive the agent's response as a stream of messages.

        Yields:
            AgentMessage instances normalized from the provider's native format.
        """
        ...

    @abstractmethod
    def supports_subagents(self) -> bool:
        """Whether this client supports native sub-agent execution.

        Returns:
            True if the provider supports parallel sub-agent execution
            (e.g., Claude SDK Task tool), False otherwise.
        """
        ...

    @abstractmethod
    def provider_name(self) -> str:
        """Return the provider identifier (e.g., 'claude', 'copilot')."""
        ...

    # Every model call of the current response, read into the harness's common
    # unit (``harness.domain``): the client knows its provider's usage format,
    # nothing downstream does. Read by ``record_client_usage`` and the context
    # guard; ``None`` until the client records a call.
    usage_ledger: UsageLedger | None = None
    # Whether the client stops a session at its own spending cap (the Claude
    # SDK does). The session runner caps every other client itself
    # (harness.application.budget).
    enforces_own_budget: bool = False
    # The tools this session sends, in canonical form and fixed when the
    # session starts (``harness.application.tools``). ``None`` for a client
    # that sends no tools of its own: the CLIs bring theirs.
    tool_set: ToolSet | None = None
    # The sub-agent roster this session may delegate to, by name
    # (``agents.subagents.resolve``): ``SubagentDefinition``s, or the SDK's
    # ``AgentDefinition``s on the Claude client, which runs them natively. On
    # every other client the roster is offered to the model as the one
    # ``delegate`` tool and run as a child session of this client
    # (``harness.application.delegation``). Empty: nothing to delegate to.
    agents: dict[str, Any] = {}
    # Set on a child session: the executor tools it may run, and nothing else.
    delegation_scope: frozenset[str] | None = None

    # The attributes a child session must not share with its parent: what the
    # parent is in the middle of (its query, its tools, its connection, its
    # ledger). Everything else — credentials, endpoints, model, project — is
    # exactly what the child needs and is copied by reference.
    _CHILD_RESET: tuple[str, ...] = (
        "_pending_query",
        "_tool_executor",
        "_mcp_manager",
        "_http_client",
        "_resumed_history",
        "usage_ledger",
        "tool_set",
        "last_usage",
        "last_context_tokens",
    )

    def delegates(self) -> bool:
        """Whether this session runs its roster itself, as child sessions.

        True for a client that runs the WorkPilot loop: the roster reaches
        the model as the ``delegate`` tool. The Claude client (native) and the
        CLIs (their own tools, no roster) answer False.
        """
        return False

    def spawn_child(self) -> AgentClient:
        """A fresh session of this client, for one sub-agent.

        A shallow copy with the transient state reset: the child opens its own
        connection and executor in ``__aenter__``, exactly as a new client
        would, and cannot delegate in turn. A client whose state does not fit
        that shape overrides this.
        """
        child = copy.copy(self)
        for attribute in self._CHILD_RESET:
            if hasattr(child, attribute):
                setattr(child, attribute, None)
        child._tool_definitions = []
        child.agents = {}
        child.delegation_scope = None
        return child

    def _freeze_tools(self, definitions: Iterable[Mapping[str, Any]]) -> None:
        """The session's tools: sorted, serialized one way, computed once.

        Every turn sends ``_tool_definitions`` as set here; a second
        preparation in the same session keeps the first set. A session with a
        roster and no delegated scope of its own also sends ``delegate``.
        """
        from harness.application.delegation import delegate_tool_definition
        from harness.application.tools import session_tools

        offered = list(definitions)
        if self.agents and self.delegates() and self.delegation_scope is None:
            offered.append(delegate_tool_definition(self.agents))
        self.tool_set = session_tools(
            offered, held=self.tool_set, owner=self.provider_name()
        )
        self._tool_definitions = list(self.tool_set.tools)

    def _start_usage_ledger(self) -> UsageLedger:
        """A fresh ledger for the response about to be received."""
        self.usage_ledger = UsageLedger()
        return self.usage_ledger

    def _record_call(
        self, usage: CallUsage | None, *, thread: str | None = None
    ) -> None:
        """One model call, already read from the provider's format."""
        if self.usage_ledger is None:
            self.usage_ledger = UsageLedger()
        self.usage_ledger.record(usage, thread=thread)
        from genai_trace.session import model_call

        model_call(usage, thread)

    def _record_subagent_return(self, report: SubagentReturn | None) -> None:
        """What one sub-agent brought back into this client's context."""
        if self.usage_ledger is None:
            self.usage_ledger = UsageLedger()
        self.usage_ledger.record_return(report)

    def resumes_native_session(self) -> bool:
        """Whether the provider itself rehydrates an earlier session.

        Only the Claude SDK does (``resume=<session_id>``); every other client
        gets its context back from the conversation log, replayed through
        :meth:`resume`.
        """
        return False

    async def resume(self, history: list[AgentMessage]) -> None:
        """Preload a conversation history before the next query() call.

        Used when a task was paused (rate-limit, auth, user) and is being
        resumed — possibly under a different provider than the one that
        produced the original transcript. Implementations should preseed
        their internal message buffer (when the SDK exposes one) or stash
        the history for the next query() to prepend it as context.

        Default implementation stores history on `self._resumed_history` and
        relies on subclasses to consult it from `query()`. Override entirely
        when a provider exposes a native `messages=[...]` parameter.

        Args:
            history: Ordered list of past AgentMessage objects to replay
                (oldest first). May contain user, assistant and system
                messages with text/tool_use/tool_result blocks.
        """
        self._resumed_history = history or []
        if history:
            logger.info(
                "[%s] resume queued: %d historical messages will be injected "
                "into the next query as a transcript preamble.",
                self.provider_name(),
                len(history),
            )

    # Async context manager protocol
    async def __aenter__(self):
        return self

    @abstractmethod
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

    # ------------------------------------------------------------------
    # Helpers for subclasses implementing resume()
    # ------------------------------------------------------------------
    def _consume_resumed_history_as_system_message(
        self, messages: list[dict[str, Any]]
    ) -> None:
        """If resume(history) was queued, append a system message containing the
        formatted preamble to `messages` (mutates in place) and clear the queue.

        Call this once per request, after `system_prompt` is added and before
        the user message. No-op when no resume() has been called.
        """
        history = getattr(self, "_resumed_history", None)
        if not history:
            return
        preamble = self._format_history_as_preamble(history)
        if preamble:
            messages.append({"role": "system", "content": preamble})
        self._resumed_history = []  # consume

    @staticmethod
    def _format_history_as_preamble(history: list[AgentMessage]) -> str:
        """Render a conversation history as a plain-text preamble.

        Used by subclasses whose SDK doesn't expose a structured messages
        parameter. The output is condensed but lossless enough for the LLM
        to reconstruct context: each message becomes a role-labeled block,
        each tool_use becomes a "called tool X with input ..." line, and
        each tool_result becomes a "got: ..." line.
        """
        if not history:
            return ""

        lines: list[str] = [
            "=== PRIOR CONVERSATION (replayed after provider switch) ===",
            "",
        ]
        for msg in history:
            role = msg.role.value if isinstance(msg.role, Enum) else str(msg.role)
            lines.append(f"[{role}]")
            for block in msg.content:
                if block.type == ContentBlockType.TEXT and block.text:
                    lines.append(block.text)
                elif block.type == ContentBlockType.THINKING and block.text:
                    # Drop thinking by default — it's provider-specific
                    # metadata that doesn't replay well across SDKs.
                    continue
                elif block.type == ContentBlockType.TOOL_USE:
                    tool = block.tool_name or "unknown"
                    inp = block.tool_input or {}
                    lines.append(f"<tool_use name={tool}> {inp!r}")
                elif block.type == ContentBlockType.TOOL_RESULT:
                    res = str(block.result_content or "")[:1000]
                    flag = " [ERROR]" if block.is_error else ""
                    lines.append(f"<tool_result{flag}> {res}")
            lines.append("")
        lines.append("=== END PRIOR CONVERSATION — continue from here ===")
        return "\n".join(lines)


# =============================================================================
# The adapters of the WorkPilot loop
# =============================================================================


class LoopAdapter:
    """What every adapter of the WorkPilot loop shares.

    The loop is ``harness.application.loop.run_turns``; an adapter is one
    response of one provider behind its port (``harness.ports.ModelPort``):
    the conversation as that provider writes it, and the state its turns
    carry. Subclasses keep the protocol (``assemble``, ``call``, ``settle``,
    ``execute``, ``reinject``); this class turns the loop's events into the
    client's messages and logs them under the client's name.
    """

    # The prefix of the client's log lines, e.g. "OpenAIAgentClient".
    label = "AgentClient"

    def __init__(self, client: AgentClient, messages: list[dict[str, Any]]):
        self.client = client
        self.messages = messages

    @property
    def provider(self) -> str:
        return self.client.provider_name()

    def text(self, text: str) -> AgentMessage:
        return AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
        )

    def notice(self, text: str) -> AgentMessage:
        return AgentMessage(
            role=MessageRole.SYSTEM,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
        )

    def tool_use(self, call: ToolCall) -> AgentMessage:
        return AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name=call.name,
                    tool_id=call.id,
                    tool_input=call.arguments,
                )
            ],
        )

    def tool_result(self, call: ToolCall, result: ToolResult) -> AgentMessage:
        return AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id=call.id,
                    is_error=result.is_error,
                    result_content=result.text,
                )
            ],
        )

    def announce(self, call: ToolCall, turn: int) -> None:
        logger.info(
            f"[{self.label}] Turn {turn + 1}: "
            f"tool_call {call.name}({list(call.arguments.keys())})"
        )
        print(f"[{self.label}] 🔧 Tool: {call.name}", flush=True)

    def remind(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def history_budget(self) -> int | None:
        """The conversation's char budget before clearing; None: the shared one."""
        return None

    def clear(self) -> None:
        # Elide stale tool results once the conversation exceeds the char
        # budget (no-op below budget, preserving the cacheable prefix).
        compacted = compact_messages(self.messages, char_budget=self.history_budget())
        if compacted:
            logger.info(
                f"[{self.label}] History compaction: elided {compacted} "
                "stale tool result(s)"
            )

    def finish(self, reason: StopReason) -> None:
        """Nothing to total by default; adapters that keep totals override."""

    async def run_tool(
        self,
        call: ToolCall,
        *,
        mcp: Any = None,
        error_prefix: str = "Tool error",
        unavailable: str = "Tool executor not available",
    ) -> ToolResult:
        """One call, through the client's MCP bridge when it serves the tool,
        else its ``ToolExecutor``: the only two ways a WorkPilot loop runs a
        tool — plus ``delegate``, which runs a child session of the client
        (``harness.application.delegation``). A failure is a result the model
        reads, never an exception."""
        from harness.application.delegation import is_delegation, run_delegation

        if is_delegation(call.name):
            if not self.client.agents or self.client.delegation_scope is not None:
                return ToolResult(
                    "No specialist is available to this session. Do the task "
                    "yourself with the tools you were given.",
                    is_error=True,
                )
            return ToolResult(await run_delegation(self.client, call.arguments))
        if mcp is not None and mcp.has_tool(call.name):
            try:
                result = await mcp.call(call.name, call.arguments)
            except Exception as e:
                logger.warning(f"[{self.label}] MCP tool {call.name} failed: {e}")
                return ToolResult(f"MCP tool error: {e}", is_error=True)
            return ToolResult(str(result) if result is not None else "")
        executor = getattr(self.client, "_tool_executor", None)
        if not executor:
            return ToolResult(unavailable, is_error=True)
        try:
            result = await executor.execute(call.name, call.arguments)
        except Exception as e:
            logger.warning(f"[{self.label}] Tool {call.name} failed: {e}")
            return ToolResult(f"{error_prefix}: {e}", is_error=True)
        return ToolResult(str(result) if result is not None else "")
