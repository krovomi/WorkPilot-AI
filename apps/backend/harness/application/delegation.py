"""Running a sub-agent as a child session of the parent's own client.

Every provider WorkPilot drives through its loop (OpenAI and the compatible
endpoints, Gemini, Ollama and LM Studio, Copilot, Windsurf) runs a sub-agent
the same way: the parent's client is cloned (``AgentClient.spawn_child``), the
clone is given the specialist's role as its system prompt, the specialist's
tools and nothing else, a short turn budget, and the task as its one user
message. It runs the same loop the parent runs, in the same worktree, under
the same security gates (``ToolExecutor``, the command allowlist); only its
last message comes back, bounded and delimited as data
(``harness.application.subagents.receive_result``), and every call it made is
recorded on the parent's ledger under its own thread.

What this is not: a second roster. The child has no ``delegate`` tool, so the
fan-out is one level deep, as the SDK's is.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from harness.domain.delegation import (
    CHILD_MAX_TURNS,
    DELEGATE_TOOL,
    child_system_prompt,
    delegate_tool_definition,
    executor_tools,
    is_delegation,
)

from .subagents import receive_result

logger = logging.getLogger(__name__)

__all__ = [
    "DELEGATE_TOOL",
    "delegate_tool_definition",
    "is_delegation",
    "run_delegation",
]


def _text_of(message: Any) -> str:
    """The text blocks of one of the client's messages, joined."""
    parts: list[str] = []
    for block in getattr(message, "content", None) or []:
        kind = getattr(block, "type", None)
        kind = getattr(kind, "value", kind)
        if kind == "text" and getattr(block, "text", None):
            parts.append(block.text)
    return "".join(parts)


def _no_such_specialist(name: str, agents: dict[str, Any]) -> str:
    roster = ", ".join(sorted(agents)) or "none"
    return (
        f"No specialist named {name!r}. The specialists you may delegate to: "
        f"{roster}. Do the task yourself if none fits."
    )


async def run_delegation(
    parent: Any,
    arguments: dict[str, Any],
    *,
    started: Callable[[], None] | None = None,
) -> str:
    """One ``delegate`` call of ``parent``: the specialist's conclusion, as data.

    Never raises: a failure is text the parent reads and acts on, like any
    other tool result. ``started`` is called when the child's first message
    arrives, so a wave of delegations can be launched staggered
    (``harness.application.subagents.launch_staggered``).
    """
    agents: dict[str, Any] = getattr(parent, "agents", None) or {}
    name = str(arguments.get("agent") or "").strip()
    task = str(arguments.get("task") or "").strip()
    definition = agents.get(name)
    if definition is None:
        return _no_such_specialist(name, agents)
    if not task:
        return "The delegation carried no task. Say what the specialist should do."

    spec_dir = getattr(parent, "_spec_dir", None)
    project_dir = getattr(parent, "_project_dir", None) or getattr(parent, "cwd", "")
    scope = executor_tools(getattr(definition, "tools", None) or [])

    try:
        child = parent.spawn_child()
    except Exception as exc:  # noqa: BLE001 — a child that cannot start is a result
        logger.warning("[delegation] %s: cannot spawn a child session: %s", name, exc)
        return f"Delegation to {name!r} failed before it started: {exc}"

    child.system_prompt = child_system_prompt(
        getattr(definition, "prompt", "") or "", project_dir=str(project_dir or "")
    )
    child.max_turns = CHILD_MAX_TURNS
    model = getattr(definition, "model", None)
    if model and model != "inherit":
        child.model = model
    child.delegation_scope = scope

    text = ""
    signalled = False
    try:
        async with child:
            _narrow_tools(child, scope)
            await child.query(task)
            async for message in child.receive_response():
                if not signalled and started is not None:
                    started()
                    signalled = True
                if (
                    getattr(message, "role", None) is not None
                    and str(getattr(message.role, "value", message.role)) == "assistant"
                ):
                    chunk = _text_of(message)
                    if chunk:
                        # The contract says the last message is the result.
                        text = chunk
    except Exception as exc:  # noqa: BLE001 — same rule: a result, not a crash
        logger.warning("[delegation] %s failed: %s", name, exc)
        if not text:
            text = f"Error: the specialist {name!r} failed: {exc}"
    finally:
        _merge_ledger(parent, child, name)

    result, report = receive_result(name, text, spec_dir=spec_dir)
    parent._record_subagent_return(report)
    logger.info(
        "[delegation] %s returned ~%d tokens (%s)",
        name,
        report.received_tokens,
        "cut" if report.cut else "whole",
    )
    return result


def _narrow_tools(child: Any, scope: frozenset[str]) -> None:
    """Only the specialist's tools, in the executor and in what the model sees.

    Done after ``__aenter__`` built the executor and froze the session's set:
    the client's own setup is reused unchanged, then cut down. A child whose
    client offers no tools (text-only mode) keeps none.
    """
    executor = getattr(child, "_tool_executor", None)
    if executor is not None:
        executor.allowed_tools = scope
    definitions = list(getattr(child, "_tool_definitions", None) or [])
    kept = [
        tool
        for tool in definitions
        if tool.get("name") in scope and tool.get("name") != DELEGATE_TOOL
    ]
    child.tool_set = None
    child._freeze_tools(kept)


def _merge_ledger(parent: Any, child: Any, name: str) -> None:
    """The child's calls, on the parent's ledger under ``subagent:<name>``."""
    ledger = getattr(child, "usage_ledger", None)
    if ledger is None:
        return
    thread = f"subagent:{name}"
    for call in ledger.calls:
        parent._record_call(call, thread=thread)
    if parent.usage_ledger is not None:
        parent.usage_ledger.boundary(thread=thread)
