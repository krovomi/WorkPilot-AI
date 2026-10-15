"""Sub-agents where WorkPilot launches them or receives what they return.

Two jobs, the same for every provider that runs sub-agents:

* **Bound what comes back** (``receive_result``). The result is cut to the
  contract's cap and marked when over it (``harness.domain.subagents``), then
  delimited as data by ``security/untrusted.py`` (S2): a sub-agent read files
  and pages the parent never saw, and its words are not the parent's
  instructions. WorkPilot receives a result in two places:
  ``CopilotAgentClient.run_subagents``, which it runs, and the PostToolUse hook
  ``create_client`` registers on the Claude Agent SDK's sub-agent tool
  (``make_subagent_result_hook``). Codex, OpenCode and Antigravity run no
  sub-agents, nor does any other WorkPilot loop.
* **Launch them staggered** (``launch_staggered``). A prompt cache is readable
  once the first response has begun. Launched together, N sub-agents that
  share a prefix each write it; launched one first, then the rest, they write
  it once and read it N − 1 times. A provider without a cache loses only the
  head start, which is bounded.

The sub-agent is told the contract where its prompt is handed to the provider
(``bind_contract``, ``subagent_messages``), not in the registry: the registry's
prompts are also emitted to harnesses whose sub-agents WorkPilot never sees.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any, TypeVar

from harness.domain.subagents import (
    RESULT_CAP_TOKENS,
    SubagentReturn,
    bound_result,
    contract_text,
    estimate_tokens,
    with_contract,
)
from security.untrusted import quote_untrusted

logger = logging.getLogger(__name__)

T = TypeVar("T")

# The names the Claude Agent SDK gives its sub-agent tool: ``Agent`` today,
# ``Task`` in the CLIs before it.
SUBAGENT_TOOLS = ("Agent", "Task")

# How long the rest of a wave waits for the first response to begin. Past it
# they go anyway, each writing the prefix itself as they all did before: a
# first sub-agent that hangs must not hold the others back.
HEAD_START_SECONDS = 30.0

SUBAGENT_SYSTEM = (
    "You are a sub-agent: a parent agent gave you one task and a role for it. "
    "Do the task, then report.\n\n"
)


def receive_result(
    name: str,
    text: str,
    *,
    spec_dir: Path | str | None = None,
    cap_tokens: int = RESULT_CAP_TOKENS,
) -> tuple[str, SubagentReturn]:
    """What the parent reads of one sub-agent's result, and its measure."""
    bound = bound_result(text, cap_tokens=cap_tokens)
    if bound.report.cut:
        logger.info(
            "[harness] sub-agent %r returned ~%d tokens, cut to its cap of %d",
            name,
            bound.report.received_tokens,
            cap_tokens,
        )
    quoted = quote_untrusted(
        bound.text,
        kind="subagent_result",
        source=f"subagent:{name}",
        spec_dir=spec_dir,
    )
    report = SubagentReturn(
        bound.report.received_tokens, estimate_tokens(quoted), bound.report.cut
    )
    return quoted, report


def _no_signal() -> None:
    """The start signal of a job nobody waits for."""


async def launch_staggered(
    jobs: Mapping[str, Callable[[Callable[[], None]], Awaitable[T]]],
    *,
    head_start: float | None = HEAD_START_SECONDS,
) -> dict[str, T | BaseException]:
    """Run every job: the first alone until its response has begun, then the rest.

    Each job is called with a ``started`` callback, which it calls when its
    response begins (its first streamed token, or its response when the
    protocol does not stream). The rest start on that signal, or as soon as
    the first job ends without giving it (it failed, or produced nothing), or
    after ``head_start`` seconds. Every outcome comes back under its name, an
    exception included: one job failing loses no other's result.
    """
    names = list(jobs)
    if not names:
        return {}
    began = asyncio.Event()
    tasks: dict[str, asyncio.Future[T]] = {
        names[0]: asyncio.ensure_future(jobs[names[0]](began.set))
    }
    try:
        if len(names) > 1:
            waiter = asyncio.ensure_future(began.wait())
            try:
                await asyncio.wait(
                    {tasks[names[0]], waiter},
                    timeout=head_start,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                waiter.cancel()
        for name in names[1:]:
            tasks[name] = asyncio.ensure_future(jobs[name](_no_signal))
        outcomes = await asyncio.gather(*tasks.values(), return_exceptions=True)
    except asyncio.CancelledError:
        for task in tasks.values():
            task.cancel()
        raise
    return dict(zip(tasks, outcomes))


def subagent_messages(
    role: str, shared: str, *, cap_tokens: int = RESULT_CAP_TOKENS
) -> list[dict[str, str]]:
    """A chat request for one sub-agent of a wave, the part the wave shares first.

    Every sub-agent of a wave gets the same contract and the same context; only
    its role differs. Sent first, as the system message, the role made every
    request's prefix unique, and a staggered launch had nothing for the others
    to read. It comes last now, after the shared prefix (stable first, lot 2).
    """
    return [
        {"role": "system", "content": SUBAGENT_SYSTEM + contract_text(cap_tokens)},
        {"role": "user", "content": shared},
        {"role": "user", "content": f"Your role for this task:\n\n{role}"},
    ]


def _with_contract_definition(definition: Any, cap_tokens: int) -> Any:
    if isinstance(definition, Mapping):
        prompt = definition.get("prompt")
        if isinstance(prompt, str):
            return {**definition, "prompt": with_contract(prompt, cap_tokens)}
        return definition
    prompt = getattr(definition, "prompt", None)
    if (
        isinstance(prompt, str)
        and dataclasses.is_dataclass(definition)
        and not isinstance(definition, type)
    ):
        return dataclasses.replace(definition, prompt=with_contract(prompt, cap_tokens))
    return definition


def bind_contract(
    agents: Mapping[str, Any] | None, *, cap_tokens: int = RESULT_CAP_TOKENS
) -> dict[str, Any] | None:
    """The roster with the contract after each sub-agent's prompt.

    A definition (the SDK's ``AgentDefinition``, ``SubagentDefinition``, or a
    dict) is copied, never edited in place: the caller's roster stays as it
    gave it. One whose prompt cannot be read is passed on unchanged.
    """
    if agents is None:
        return None
    return {
        name: _with_contract_definition(definition, cap_tokens)
        for name, definition in agents.items()
    }


def content_text(content: object) -> str | None:
    """The text of a tool result's content: a string, or a list of text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"]
            for block in content
            if isinstance(block, Mapping)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        )
    return None


def make_subagent_result_hook(
    spec_dir: Path | str | None, *, cap_tokens: int = RESULT_CAP_TOKENS
) -> Callable[..., Awaitable[dict[str, Any]]]:
    """A PostToolUse hook for the Claude Agent SDK's sub-agent tool.

    The CLI runs the sub-agent; this hook is where WorkPilot sees the result
    before the parent does. The tool's output is ``{"content": [text blocks],
    "agentId": …, "usage": …}``: only the text is replaced, so the output keeps
    the shape the CLI checks (it drops a rewrite of another shape and keeps the
    original). An output without content (a sub-agent launched in the
    background) is left alone.
    """

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        if input_data.get("tool_name") not in SUBAGENT_TOOLS:
            return {}
        try:
            response = input_data.get("tool_response")
            raw = response.get("content") if isinstance(response, Mapping) else response
            text = content_text(raw)
            if text is None:
                return {}
            tool_input = input_data.get("tool_input")
            name = (
                tool_input.get("subagent_type")
                if isinstance(tool_input, Mapping)
                else None
            )
            quoted, _ = receive_result(
                str(name or "agent"), text, spec_dir=spec_dir, cap_tokens=cap_tokens
            )
            if isinstance(response, Mapping):
                updated: Any = {
                    **response,
                    "content": [{"type": "text", "text": quoted}],
                }
            else:
                updated = quoted
        except Exception:  # noqa: BLE001 - a measure must never break a session
            logger.debug("sub-agent result hook skipped", exc_info=True)
            return {}
        return {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "updatedToolOutput": updated,
            }
        }

    return _hook
