"""How a tool's result is shown: console, debug log and the task's activity feed.

The same for every provider: ``agents.session`` calls it from the Claude SDK
stream and from the normalized ``AgentClient`` stream alike.
"""

from __future__ import annotations

from typing import Any

from foundation.debug import debug_detailed, debug_error

#: Tools whose full result is kept in the feed's expandable detail.
_DETAILED_TOOLS = ("Read", "Grep", "Bash", "Edit", "Write")
#: Larger results are not kept (a Glob of the whole tree, say).
_MAX_DETAIL = 50_000


def show_tool_result(
    task_logger: Any,
    tool: str | None,
    content: Any,
    is_error: bool,
    *,
    verbose: bool,
    phase: Any,
) -> None:
    """Print a tool's result and close its entry in the activity feed."""
    text = str(content)
    if is_error and "blocked" in text.lower():
        # A command the security hook refused.
        debug_error("session", f"Tool BLOCKED: {tool}", result=text[:300])
        print(f"   [BLOCKED] {content}", flush=True)
        if task_logger and tool:
            task_logger.tool_end(
                tool, success=False, result="BLOCKED", detail=text, phase=phase
            )
        return
    if is_error:
        error_str = text[:500]
        debug_error("session", f"Tool error: {tool}", error=error_str[:200])
        print(f"   [Error] {error_str}", flush=True)
        if task_logger and tool:
            task_logger.tool_end(
                tool, success=False, result=error_str[:100], detail=text, phase=phase
            )
        return
    debug_detailed("session", f"Tool success: {tool}", result_length=len(text))
    print(f"   [Done] {text[:200]}" if verbose else "   [Done]", flush=True)
    if task_logger and tool:
        detail = text if tool in _DETAILED_TOOLS and len(text) < _MAX_DETAIL else None
        task_logger.tool_end(tool, success=True, detail=detail, phase=phase)


__all__ = ["show_tool_result"]
