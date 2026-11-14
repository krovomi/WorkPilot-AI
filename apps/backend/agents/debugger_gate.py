"""The Agent Debugger for the providers whose tools WorkPilot runs itself.

Claude runs its tools inside the SDK, where ``create_client`` installs the
breakpoint hook (``agents.debugger.make_persistent_debugger_hook``). OpenAI,
Copilot, Windsurf, Gemini, Mistral, Ollama and the other loop providers ask
``core.runtimes.tool_executor.ToolExecutor`` to run theirs, and never met that
hook: a breakpoint set in the Debugger never paused them.

:func:`gate_tool_call` is the same hook, called by the executor before a tool
runs. The executor's names are mapped to the SDK's (``write_file`` is
``Write``, ``run_command`` is ``Bash``), so one breakpoint pauses every
provider. Agents that run their tools in their own CLI (Codex, OpenCode, pi,
Antigravity) are out of reach of both.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .debugger import make_persistent_debugger_hook

logger = logging.getLogger(__name__)

_PATH_KEYS = ("path", "file_path", "filepath", "filename", "file")
_CONTENT_KEYS = ("content", "CodeContent", "text", "data", "file_text")
_COMMAND_KEYS = ("command", "cmd", "shell_command", "script", "commandline")

# Executor tool name → the SDK tool a breakpoint names.
_SDK_NAMES = {"write_file": "Write", "Write": "Write", "run_command": "Bash"}

# One hook per debugger session: it caches the breakpoints it read.
_hooks: dict[str, Any] = {}


@dataclass(frozen=True)
class GateResult:
    """What the person decided at a breakpoint: the arguments to run, or a refusal."""

    arguments: dict[str, Any]
    refusal: str | None = None


def _first(arguments: dict[str, Any], keys: tuple[str, ...]) -> Any:
    return next((arguments[k] for k in keys if arguments.get(k) is not None), None)


def _sdk_input(sdk_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if sdk_name == "Bash":
        return {"command": str(_first(arguments, _COMMAND_KEYS) or "")}
    if sdk_name == "Write":
        return {
            "file_path": str(_first(arguments, _PATH_KEYS) or ""),
            "content": str(_first(arguments, _CONTENT_KEYS) or ""),
        }
    return dict(arguments)


def _executor_arguments(
    sdk_name: str, original: dict[str, Any], modified: dict[str, Any]
) -> dict[str, Any]:
    """A modified SDK input, back in the executor's first alias of each key."""
    if sdk_name == "Bash":
        kept = {k: v for k, v in original.items() if k not in _COMMAND_KEYS}
        return {**kept, "command": str(modified.get("command", ""))}
    if sdk_name == "Write":
        kept = {
            k: v
            for k, v in original.items()
            if k not in _PATH_KEYS and k not in _CONTENT_KEYS
        }
        return {
            **kept,
            "path": str(modified.get("file_path", "")),
            "content": str(modified.get("content", "")),
        }
    return dict(modified)


async def gate_tool_call(
    spec_dir: Path | None, tool_name: str, arguments: dict[str, Any]
) -> GateResult:
    """Pause ``tool_name`` on a matching breakpoint until the person resumes it.

    A run without a spec, or a session without breakpoints, passes straight
    through (the hook stats one file). The hook is fail-safe: whatever goes
    wrong, the call runs as the model asked.
    """
    if spec_dir is None or not spec_dir.name:
        return GateResult(arguments)
    session_id = spec_dir.name
    hook = _hooks.get(session_id)
    if hook is None:
        hook = _hooks[session_id] = make_persistent_debugger_hook(session_id)
    sdk_name = _SDK_NAMES.get(tool_name, tool_name)
    output = await hook(
        {"tool_name": sdk_name, "tool_input": _sdk_input(sdk_name, arguments)}
    )
    decision = (output or {}).get("hookSpecificOutput") or {}
    if decision.get("permissionDecision") == "deny":
        reason = decision.get("permissionDecisionReason") or "Skipped by debugger"
        logger.info("tool %s skipped at a debugger breakpoint", tool_name)
        return GateResult(
            arguments,
            refusal=f"Tool '{tool_name}' was skipped by the person debugging this run: {reason}",
        )
    modified = decision.get("modifiedToolInput")
    if isinstance(modified, dict):
        return GateResult(_executor_arguments(sdk_name, arguments, modified))
    return GateResult(arguments)
