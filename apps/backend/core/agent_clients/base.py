"""The provider-agnostic contract every agent client speaks: messages,
content blocks, subagent definitions, the `AgentClient` ABC, and the helpers
several providers share (environment parsing, Retry-After, output nudges).

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from harness.domain import CallUsage, UsageLedger

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
        from datetime import datetime, timezone

        now = datetime.now(reset_dt.tzinfo or timezone.utc)
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
