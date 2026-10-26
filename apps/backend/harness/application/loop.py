"""The WorkPilot loop, written once for every provider it runs.

Each client in ``core/agent_clients/`` that runs its own tool loop had a copy
of it: five in all. A turn is: assemble the request from the conversation,
call the model, measure the call, execute the tools it asked for, put their
results back, decide. Each provider's protocol stays in its adapter,
behind ``harness.ports.ModelPort``; the decisions are the domain's: when to stop
(``harness.domain.stop``), whether the model is making progress
(``harness.domain.progress``), what to clear (``harness.domain.policies``, which
the adapter's ``clear`` applies to its own message format). The loop holds no
threshold and no provider name.

Every tool goes through the adapter's ``execute``, which hands it to the
client's ``ToolExecutor`` (or its MCP bridge) as before: the loop adds no
execution path. One ordering rule is the loop's: the ``delegate`` calls of a
turn run together (``harness.domain.delegation``), because a model that asks
three specialists in one turn means them in parallel, as the SDK runs them;
every other tool runs in the order asked, as before.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import aclosing
from typing import Any

from genai_trace.session import model_call
from harness.domain.delegation import is_delegation
from harness.domain.ledger import UsageLedger
from harness.domain.progress import (
    NO_PROGRESS_STOP,
    PROGRESS_NUDGE,
    ProgressTracker,
    Verdict,
    turn_fingerprint,
)
from harness.domain.stop import stop_reason
from harness.ports import Measured, ModelPort, Outcome, Reply, ToolCall, ToolResult

logger = logging.getLogger(__name__)


async def run_turns(
    port: ModelPort, *, max_turns: int, ledger: UsageLedger
) -> AsyncIterator[Any]:
    """Drive ``port`` until a stop reason, yielding the client's messages.

    ``ledger`` is the client's ledger for this response, already restarted:
    the session runner prices it after every message.
    """
    progress = ProgressTracker()
    turns = 0
    reason = stop_reason(turns=turns, max_turns=max_turns)
    while reason is None:
        # Assemble, call, measure.
        answer: list[Reply | Outcome] = []
        call = port.call(port.assemble(turns), turns)
        async with aclosing(_relay(call, ledger, answer)) as relay:
            async for message in relay:
                yield message
        outcome = answer[-1] if answer else Outcome.HALT
        verdict: Verdict = "continue"
        if isinstance(outcome, Reply):
            if outcome.text:
                yield port.text(outcome.text)
            if outcome.calls:
                # Execute, reinject, then decide: the progress rule, the clearing.
                results: list[ToolResult] = []
                wave_at = [
                    i for i, c in enumerate(outcome.calls) if is_delegation(c.name)
                ]
                if len(wave_at) > 1:
                    # A wave: announced together, run together, reported in
                    # the order asked. The other calls of the turn follow.
                    for i in wave_at:
                        port.announce(outcome.calls[i], turns)
                        yield port.tool_use(outcome.calls[i])
                    ran = await _together(port, [outcome.calls[i] for i in wave_at])
                    wave = dict(zip(wave_at, ran, strict=True))
                    for i, tool_call in enumerate(outcome.calls):
                        if i in wave:
                            result = wave[i]
                        else:
                            port.announce(tool_call, turns)
                            yield port.tool_use(tool_call)
                            result = await port.execute(tool_call)
                        yield port.tool_result(tool_call, result)
                        results.append(result)
                else:
                    for tool_call in outcome.calls:
                        port.announce(tool_call, turns)
                        yield port.tool_use(tool_call)
                        result = await port.execute(tool_call)
                        yield port.tool_result(tool_call, result)
                        results.append(result)
                port.reinject(outcome, results)
                verdict = progress.observe(
                    turn_fingerprint(
                        (tool_call.name, tool_call.arguments, result.text)
                        for tool_call, result in zip(
                            outcome.calls, results, strict=True
                        )
                    )
                )
                if verdict == "nudge":
                    port.remind(PROGRESS_NUDGE)
                if verdict != "stop":
                    port.clear()
                outcome = Outcome.AGAIN
            else:
                # No tool call: the adapter says whether that ends the response.
                notes, outcome = port.settle(outcome, turns)
                for note in notes:
                    yield note
        if outcome is Outcome.HALT:
            return
        turns += 1
        reason = stop_reason(
            turns=turns,
            max_turns=max_turns,
            done=outcome is Outcome.DONE,
            progress=verdict,
        )
    if reason == "no_progress":
        logger.warning("[%s] %s", port.provider, NO_PROGRESS_STOP)
        yield port.notice(NO_PROGRESS_STOP)
    port.finish(reason)


async def _relay(
    events: AsyncIterator[Any], ledger: UsageLedger, answer: list[Reply | Outcome]
) -> AsyncIterator[Any]:
    """A call's messages, passed on; its measure, recorded; its answer, kept.

    Closed with the loop, so an adapter's ``finally`` (a request to cancel)
    runs when the session runner stops reading, as it did inline.
    """
    async with aclosing(events):
        async for event in events:
            if isinstance(event, Measured):
                ledger.record(event.usage)
                model_call(event.usage)
            elif isinstance(event, (Reply, Outcome)):
                answer.append(event)
            else:
                yield event


async def _together(port: ModelPort, calls: Sequence[ToolCall]) -> list[ToolResult]:
    """``calls`` executed concurrently; a failure is that call's result."""
    outcomes = await asyncio.gather(
        *(port.execute(call) for call in calls), return_exceptions=True
    )
    results: list[ToolResult] = []
    for call, outcome in zip(calls, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            logger.warning("[%s] %s failed: %s", port.provider, call.name, outcome)
            results.append(ToolResult(f"{call.name} failed: {outcome}", is_error=True))
        else:
            results.append(outcome)
    return results
