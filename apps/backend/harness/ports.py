"""What the WorkPilot loop needs from a provider: the model port.

The loop (``harness.application.loop``) is written once. Each provider keeps
its protocol in an adapter, next to its client in ``core/agent_clients/``: the
format of the conversation, the request, the call, the reading of the answer
and of the tool calls in it. The adapter speaks to the loop in the types below,
so the loop never sees a provider name, a payload or a wire format.

A call yields, in this order: any message for the session runner (a heartbeat,
an error), the measure of the call when the provider reports one, then exactly
one ``Reply`` or ``Outcome``. ``AGAIN`` spends the turn: the next one asks
again (an empty answer, a model pulled, a nudge). ``HALT`` ends the response at
once, without the totals of a finished one: the adapter has said why.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from harness.domain.stop import StopReason
from harness.domain.usage import CallUsage


@dataclass(frozen=True)
class ToolCall:
    """One tool call the model asked for, read from the provider's format."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    text: str
    is_error: bool = False


@dataclass(frozen=True)
class Reply:
    """An answer the loop acts on: text for the user, the calls to execute."""

    text: str
    calls: tuple[ToolCall, ...] = ()
    # The adapter's own record of the answer, to put it back in the
    # conversation as its protocol writes it.
    raw: Any = None


@dataclass(frozen=True)
class Measured:
    """One model call, already read into the harness's unit."""

    usage: CallUsage | None


class Outcome(Enum):
    DONE = "done"
    AGAIN = "again"
    HALT = "halt"


class ModelPort(Protocol):
    """One response of one provider, as the loop drives it."""

    @property
    def provider(self) -> str: ...

    def assemble(self, turn: int) -> Any:
        """This turn's request, from the conversation so far."""
        ...

    def call(self, request: Any, turn: int) -> AsyncIterator[Any]:
        """Send the request and read the answer (see the module docstring)."""
        ...

    def settle(self, reply: Reply, turn: int) -> tuple[list[Any], Outcome]:
        """A reply with no tool call: the messages it adds, and whether it ends
        the response, is asked again, or halts it."""
        ...

    def announce(self, call: ToolCall, turn: int) -> None: ...

    async def execute(self, call: ToolCall) -> ToolResult: ...

    def reinject(self, reply: Reply, results: Sequence[ToolResult]) -> None:
        """The assistant turn and its results, back into the conversation."""
        ...

    def remind(self, text: str) -> None:
        """A note to the model, appended to the conversation."""
        ...

    def clear(self) -> None:
        """Clear old tool results, when ``harness.domain.policies`` says so."""
        ...

    def finish(self, reason: StopReason) -> None:
        """The response is over, for ``reason``: totals, last log line."""
        ...

    # The messages the session runner receives.
    def text(self, text: str) -> Any: ...

    def notice(self, text: str) -> Any: ...

    def tool_use(self, call: ToolCall) -> Any: ...

    def tool_result(self, call: ToolCall, result: ToolResult) -> Any: ...
