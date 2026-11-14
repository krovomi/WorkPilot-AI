"""What an agent session leaves for the Replay and Debugger views, for every provider.

``run_agent_session`` has two loops: the raw Claude SDK one and the
provider-agnostic one (``_run_agent_client_session``) that the planner and the
coder use for every provider, Claude included. Only the first used to feed the
replay recorder, so the "Agent de Replay" view stayed empty for builds, and no
loop told the Agent Debugger that a run existed, so it had nothing to attach to
unless the person had attached before the run started.

:class:`SessionRecording` is the one place both loops report to: the replay
record (``~/.workpilot/replays/``) and the debugger's list of live runs
(``agents.debugger_store``, keyed by the spec name, which is the session id the
breakpoint hooks read). Telemetry never costs a session: every call swallows
the failures it can meet and turns the recording off.
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Any

from .tool_display import (
    extract_streaming_command,
    extract_streaming_file_change,
    is_command_tool,
)

logger = logging.getLogger(__name__)

# What a recorder or the debugger store can raise: disk, JSON, a field of an
# unexpected shape. Anything else is a bug worth seeing.
_TELEMETRY_ERRORS = (OSError, ValueError, TypeError, KeyError, AttributeError)

# The phase a session runs in, as the role the Replay view shows.
_PHASE_ROLES = {
    "planning": "planner",
    "coding": "coder",
    "validation": "qa_reviewer",
    "qa_fix": "qa_fixer",
}

# Edit-style tools change a file that already exists.
_EDIT_TOOLS = {"edit", "multiedit", "edit_file", "str_replace", "str_replace_editor"}

# The longest tool output kept on a replay step.
_OUTPUT_CHARS = 2000


def _phase_value(phase: Any) -> str:
    return str(getattr(phase, "value", phase) or "")


def debugger_session_id(spec_dir: Path | None) -> str | None:
    """The id the Agent Debugger knows a run by: its spec's folder name."""
    return spec_dir.name if spec_dir is not None and spec_dir.name else None


class SessionRecording:
    """One agent session, as the Replay and Debugger views see it."""

    def __init__(
        self,
        spec_dir: Path | None,
        phase: Any,
        *,
        provider: str,
        model: str,
    ) -> None:
        self._recorder: Any = None
        self._replay_id: str | None = None
        self._debug_id = debugger_session_id(spec_dir)
        # The pending tool call and whether it changed a file, whose step
        # already holds the change (no result step for it).
        self._tool: str | None = None
        self._tool_wrote = False
        if spec_dir is None:
            return
        role = _PHASE_ROLES.get(_phase_value(phase), _phase_value(phase) or "agent")
        self._start_replay(spec_dir, role, provider, model)
        self._announce_run(spec_dir, role, provider, model)

    # -- start ---------------------------------------------------------------

    def _start_replay(
        self, spec_dir: Path, role: str, provider: str, model: str
    ) -> None:
        try:
            from replay.recorder import get_replay_recorder
        except ImportError:
            return
        try:
            recorder = get_replay_recorder()
            replay_id = uuid.uuid4().hex[:16]
            session = recorder.start_session(
                replay_id,
                {
                    "agent_name": role.replace("_", " ").title(),
                    "agent_type": role,
                    "provider": provider,
                    "model": model,
                    "task": spec_dir.name,
                    "project_path": str(spec_dir.parent.parent.parent),
                },
            )
            # Listed as soon as it starts ("recording"), not only once it ends.
            recorder.save_session(session)
        except _TELEMETRY_ERRORS:
            logger.debug("replay recording not started", exc_info=True)
            return
        self._recorder, self._replay_id = recorder, replay_id

    def _announce_run(
        self, spec_dir: Path, role: str, provider: str, model: str
    ) -> None:
        if self._debug_id is None:
            return
        try:
            from agents import debugger_store

            debugger_store.register_active(
                self._debug_id,
                {
                    "project": str(spec_dir.parent.parent.parent),
                    "spec": self._debug_id,
                    "agent_type": role,
                    "provider": provider,
                    "model": model,
                    "pid": os.getpid(),
                },
            )
        except _TELEMETRY_ERRORS:
            logger.debug("debugger session not announced", exc_info=True)
            self._debug_id = None

    # -- during --------------------------------------------------------------

    def _record(self, method: str, *args: Any, **kwargs: Any) -> None:
        if self._recorder is None:
            return
        try:
            getattr(self._recorder, method)(self._replay_id, *args, **kwargs)
        except _TELEMETRY_ERRORS:
            logger.debug("replay %s failed, recording stopped", method, exc_info=True)
            self._recorder = None

    def text(self, text: str) -> None:
        """A piece of the agent's answer."""
        if text and text.strip():
            self._record("record_response", text)

    def tool_use(self, tool_name: str, tool_input: dict[str, Any] | None) -> None:
        """A tool call, named the way its provider names it."""
        self._tool = tool_name
        inp = tool_input if isinstance(tool_input, dict) else {}
        change = extract_streaming_file_change(tool_name, inp)
        self._tool_wrote = change is not None
        if change is not None:
            path, content = change
            operation = "update" if tool_name.lower() in _EDIT_TOOLS else "create"
            after = inp.get("new_string") or content or ""
            self._record(
                "record_file_change",
                path,
                operation=operation,
                after_content=str(after),
            )
            return
        command = extract_streaming_command(tool_name, inp)
        if command:
            self._record("record_command", command)
            return
        self._record("record_tool_call", tool_name, tool_input_dict=inp)

    def tool_result(self, result: Any, *, is_error: bool) -> None:
        """The result of the last tool call (a file change already holds its own)."""
        tool, self._tool = self._tool, None
        if not tool:
            return
        output = str(result)[:_OUTPUT_CHARS]
        if is_command_tool(tool):
            self._record("record_command_output", output, is_error=is_error)
        elif not self._tool_wrote:
            self._record(
                "record_tool_result", tool, output=output, success=not is_error
            )

    def usage(self, input_tokens: Any, output_tokens: Any, cost_usd: Any) -> None:
        """What the session cost, as its provider reported it."""
        try:
            tokens_in, tokens_out = int(input_tokens or 0), int(output_tokens or 0)
            cost = float(cost_usd or 0.0)
        except (TypeError, ValueError):
            return
        if tokens_in or tokens_out or cost:
            self._record(
                "record_usage",
                input_tokens=tokens_in,
                output_tokens=tokens_out,
                cost_usd=cost,
            )

    # -- end -----------------------------------------------------------------

    def end(self, status: str = "completed") -> None:
        """Save the replay and take the run off the debugger's live list. Once."""
        self._record("end_session", status=status)
        self._recorder = None
        if self._debug_id is not None:
            try:
                from agents import debugger_store

                debugger_store.deactivate(self._debug_id)
            except _TELEMETRY_ERRORS:
                logger.debug("debugger session not deactivated", exc_info=True)
            self._debug_id = None


def client_usage(client: Any) -> tuple[int, int, float]:
    """Tokens and cost an ``AgentClient`` reported for its last turn."""
    usage = getattr(client, "last_usage", None)
    if not isinstance(usage, dict):
        return 0, 0, 0.0
    return (
        usage.get("input_tokens") or 0,
        usage.get("output_tokens") or 0,
        usage.get("cost_usd") or 0.0,
    )
