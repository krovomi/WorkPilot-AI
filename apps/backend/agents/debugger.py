"""
Agent Debugger — interactive breakpoint + inspection layer for agent sessions.

Provider-agnostic by design: the debugger intercepts Claude Agent SDK tool
invocations before they run, so it works uniformly whether the underlying
model is Anthropic, OpenAI, Copilot, Windsurf, Ollama, etc. — the SDK
normalises tool calls across all providers.

Core model
----------
- :class:`Breakpoint` — a predicate describing when to pause (tool name +
  optional path / content / command pattern).
- :func:`make_persistent_debugger_hook` — the ``PreToolUse`` hook
  ``core.client.create_client`` installs: it reads the breakpoints and records
  the paused frames in :mod:`agents.debugger_store`, the file the UI's one-shot
  ``runners/agent_debugger_runner.py`` reads and resumes.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Breakpoint:
    """A condition that pauses the agent before a tool runs."""

    id: str
    tool: str  # "Write" | "Edit" | "Bash" | "*"
    path_pattern: str | None = None
    content_pattern: str | None = None
    command_pattern: str | None = None
    enabled: bool = True

    def matches(self, tool_name: str, tool_input: dict[str, Any]) -> bool:
        if not self.enabled:
            return False
        if self.tool != "*" and self.tool != tool_name:
            return False

        if tool_name == "Bash":
            command = str(tool_input.get("command", ""))
            if self.command_pattern and not re.search(self.command_pattern, command):
                return False
            return True

        path = str(tool_input.get("file_path") or tool_input.get("path") or "")
        if self.path_pattern and not re.search(self.path_pattern, path):
            return False

        content = str(tool_input.get("content") or tool_input.get("new_string") or "")
        if self.content_pattern and not re.search(self.content_pattern, content):
            return False
        return True


# ---------------------------------------------------------------------------
# Cross-process SDK hook (file-backed)
# ---------------------------------------------------------------------------


def _decision_to_hook_output(decision: dict[str, Any]) -> dict[str, Any]:
    """Translate a resume decision into a PreToolUse hook result."""
    action = decision.get("action")
    if action == "skip":
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.get(
                    "reason", "Skipped by debugger"
                ),
            }
        }
    if action == "modify":
        modified = decision.get("tool_input")
        if isinstance(modified, dict):
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "modifiedToolInput": modified,
                }
            }
    return {}


def make_persistent_debugger_hook(
    session_id: str,
    *,
    poll_interval: float = 0.5,
    timeout: float = 300.0,
):
    """PreToolUse hook that respects breakpoints stored on disk.

    It reads breakpoints from the file-backed :mod:`agents.debugger_store` and
    blocks by *polling* the store
    for a resume decision. That is what makes it work when the resume is issued
    from a different process (the one-shot ``agent_debugger_runner.py`` the UI
    spawns) — an in-memory ``asyncio.Event`` could never be signalled across
    the process boundary.

    Safety: the hook is fully fail-safe. Any error (corrupt store, IO failure,
    missing SDK fields) results in ``{}`` so a live agent run is never broken by
    the debugger. When the session has no enabled breakpoints it fast-paths on a
    single ``stat`` call, and an in-closure mtime cache avoids re-reading the
    store on every tool call.
    """
    from agents import debugger_store

    _cache: dict[str, Any] = {"mtime": None, "breakpoints": []}

    def _breakpoints() -> list[Breakpoint]:
        try:
            mtime = debugger_store.state_path().stat().st_mtime
        except OSError:
            _cache["mtime"] = None
            _cache["breakpoints"] = []
            return []
        if mtime != _cache["mtime"]:
            _cache["mtime"] = mtime
            _cache["breakpoints"] = [
                Breakpoint(
                    id=str(bp.get("id") or "bp"),
                    tool=str(bp.get("tool") or "*"),
                    path_pattern=bp.get("path_pattern"),
                    content_pattern=bp.get("content_pattern"),
                    command_pattern=bp.get("command_pattern"),
                    enabled=bool(bp.get("enabled", True)),
                )
                for bp in debugger_store.list_breakpoints(session_id)
            ]
        return _cache["breakpoints"]

    async def _await_resume(frame_id: str) -> dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            frame = debugger_store.get_frame(session_id, frame_id)
            if frame is None:
                return {"action": "continue", "reason": "frame_removed"}
            decision = frame.get("resume_decision")
            if decision:
                return decision
            await asyncio.sleep(poll_interval)
        logger.warning(
            "Debugger resume timeout for frame %s — auto-continuing.", frame_id
        )
        return {"action": "continue", "reason": "timeout"}

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,  # noqa: ARG001
        context: Any | None = None,  # noqa: ARG001
    ) -> dict[str, Any]:
        try:
            breakpoints = _breakpoints()
            if not breakpoints:
                return {}

            tool_name = str(input_data.get("tool_name") or "")
            tool_input = input_data.get("tool_input") or {}
            if not isinstance(tool_input, dict):
                return {}

            bp = next(
                (b for b in breakpoints if b.matches(tool_name, tool_input)),
                None,
            )
            if bp is None:
                return {}

            frame_id = debugger_store.add_frame(
                session_id,
                {
                    "session_id": session_id,
                    "breakpoint_id": bp.id,
                    "tool_name": tool_name,
                    "tool_input": dict(tool_input),
                },
            )
            decision = await _await_resume(frame_id)
            debugger_store.remove_frame(session_id, frame_id)
            return _decision_to_hook_output(decision)
        except Exception:  # noqa: BLE001 — never let the debugger break a run
            logger.debug("persistent debugger hook failed", exc_info=True)
            return {}

    return _hook
