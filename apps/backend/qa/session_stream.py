"""One QA agent session's stream: shown, logged, recorded, measured.

The reviewer and the fixer each carried two copies of this loop, one for a
raw `ClaudeSDKClient` and one for an `AgentClient`, about a thousand lines in
all. Every caller builds its client with `create_agent_client`, so only the
`AgentClient` copies ever ran, and they had drifted from the others: a Claude
session that ended on an error (rate limit, expired sign-in) was reported as
a reviewer that forgot to update the plan, and as a fixer that had fixed
everything; the Session History card of a QA pass never named its model.
This module is the one loop both run.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.agent_client import AgentClient, ContentBlockType
from foundation.debug import debug, debug_detailed, debug_error, debug_success
from replay.recorder import get_replay_recorder
from task_logger import LogEntryType, LogPhase

#: Tools whose whole result is kept for the log's expandable view.
_DETAILED_TOOLS = frozenset({"Read", "Grep", "Bash", "Edit", "Write"})
_MAX_DETAIL = 50_000
_MAX_INPUT_SHOWN = 2_000


@dataclass
class SessionOutcome:
    """What a QA session's stream produced."""

    response_text: str = ""
    message_count: int = 0
    tool_count: int = 0
    #: The provider's own error for the session (rate limit, sign-in, crash).
    result_error: str | None = None


class _Replay:
    """The Session History recording: best effort, never at the session's cost."""

    def __init__(self, metadata: dict[str, Any]):
        self.session_id = uuid.uuid4().hex[:16]
        try:
            self._recorder = get_replay_recorder()
            self._recorder.start_session(self.session_id, metadata)
        except Exception:  # noqa: BLE001 - replay is telemetry
            self._recorder = None

    def __call__(self, method: str, *args: Any, **kwargs: Any) -> None:
        if self._recorder is None:
            return
        try:
            getattr(self._recorder, method)(self.session_id, *args, **kwargs)
        except Exception:  # noqa: BLE001 - replay is telemetry
            pass

    def tool_use(self, name: str, inp: dict) -> None:
        if name in ("Edit", "Write") and inp.get("file_path"):
            self(
                "record_file_change",
                inp["file_path"],
                operation="update" if name == "Edit" else "create",
                after_content=str(inp.get("new_string") or inp.get("content") or ""),
            )
        elif name == "Bash" and inp.get("command"):
            self("record_command", inp["command"])
        else:
            self("record_tool_call", name, tool_input_dict=inp)

    def tool_result(self, name: str, content: Any, is_error: bool) -> None:
        text = str(content)[:2000]
        if name == "Bash":
            self("record_command_output", text, is_error=is_error)
        elif name not in ("Edit", "Write"):
            self("record_tool_result", name, output=text, success=not is_error)


def note_command(commands_seen: list[str] | None, inp: Any) -> None:
    """Keep the shell command of a tool call, whatever the provider named it.

    The targeted gate reads them to check that each mapped test was run in
    the session, not only declared passed in the sign-off.
    """
    if commands_seen is None or not isinstance(inp, dict):
        return
    for key in ("command", "cmd"):
        value = inp.get(key)
        if value:
            commands_seen.append(
                " ".join(map(str, value)) if isinstance(value, list) else str(value)
            )
            return


def _input_display(inp: dict) -> str | None:
    """The one line a tool call shows: its file, its pattern or its command."""
    if "file_path" in inp:
        path = str(inp["file_path"])
        if len(path) > _MAX_INPUT_SHOWN:
            path = "..." + path[-(_MAX_INPUT_SHOWN - 3) :]
        return path
    if "pattern" in inp:
        return f"pattern: {inp['pattern']}"
    if "command" in inp:
        command = str(inp["command"])
        if len(command) > _MAX_INPUT_SHOWN:
            command = command[: _MAX_INPUT_SHOWN - 3] + "..."
        return command
    return None


def _result_error(client: AgentClient) -> str | None:
    """The error the provider ended the session with, if it did.

    Claude reports it on its final ResultMessage, which `ClaudeAgentClient`
    keeps as `last_result_msg`; the normalised RESULT block does not carry it.
    """
    result = getattr(client, "last_result_msg", None)
    if result is None or getattr(result, "is_error", False) is not True:
        return None
    return getattr(result, "result", None) or (
        f"SDK error (subtype={getattr(result, 'subtype', None)})"
    )


def _context_guard(client: AgentClient, spec_dir: Path, prompt: str) -> Any:
    """The context gauge, measuring only: each QA pass starts on a fresh thread."""
    from agents.session import _make_context_guard

    guard = _make_context_guard(
        client,
        spec_dir,
        "validation",
        None,
        client.provider_name(),
        str(getattr(client, "model", "") or ""),
    )
    if guard is not None:
        guard.monitor_only = True
        guard.base_chars = len(prompt)
    return guard


async def stream_session(
    client: AgentClient,
    prompt: str,
    *,
    agent_type: str,
    agent_name: str,
    tool_label: str,
    spec_dir: Path,
    project_dir: Path,
    task_logger: Any,
    verbose: bool = False,
    commands_seen: list[str] | None = None,
    on_query_sent: Callable[[], None] | None = None,
) -> SessionOutcome:
    """Send `prompt` and follow the stream to its end.

    Text is printed and logged, each tool call is shown, logged and recorded
    for Session History, usage reaches the cost data, and the provider's own
    error, if any, is returned in `result_error`. An exception from the client
    is raised after the recording is closed as failed.
    """
    provider = client.provider_name()
    debug(
        agent_type, f"Starting {provider} {agent_name} session", spec_dir=str(spec_dir)
    )
    print(f"Sending {agent_name} prompt to {provider} agent...\n")
    replay = _Replay(
        {
            "agent_name": agent_name,
            "agent_type": agent_type,
            "task": spec_dir.name,
            "project_path": str(project_dir),
            "provider": provider,
            "model": str(getattr(client, "model", "") or ""),
        }
    )
    guard = _context_guard(client, spec_dir, prompt)
    outcome = SessionOutcome()
    current_tool: str | None = None
    finished = False

    try:
        await client.query(prompt)
        if on_query_sent is not None:
            on_query_sent()
        debug_success(agent_type, "Query sent successfully")

        async for message in client.receive_response():
            outcome.message_count += 1
            debug_detailed(
                agent_type,
                f"Received message #{outcome.message_count}",
                msg_type=message.type_name,
            )
            if guard is not None:
                try:
                    guard.observe(message)
                except Exception:  # noqa: BLE001 - the gauge is a mirror
                    pass

            for block in message.content:
                if block.type == ContentBlockType.TEXT and block.text:
                    outcome.response_text += block.text
                    print(block.text, end="", flush=True)
                    if block.text.strip():
                        if task_logger:
                            task_logger.log(
                                block.text,
                                LogEntryType.TEXT,
                                LogPhase.VALIDATION,
                                print_to_console=False,
                            )
                        replay("record_response", block.text)

                elif block.type == ContentBlockType.TOOL_USE:
                    current_tool = block.tool_name or ""
                    outcome.tool_count += 1
                    inp = block.tool_input or {}
                    note_command(commands_seen, inp)
                    shown = _input_display(inp)
                    debug(
                        agent_type,
                        f"Tool call #{outcome.tool_count}: {current_tool}",
                        tool_input=shown,
                    )
                    if task_logger:
                        task_logger.tool_start(
                            current_tool,
                            shown,
                            LogPhase.VALIDATION,
                            print_to_console=True,
                        )
                    else:
                        print(f"\n[{tool_label}: {current_tool}]", flush=True)
                    if verbose and inp:
                        text = str(inp)
                        suffix = "..." if len(text) > 300 else ""
                        print(f"   Input: {text[:300]}{suffix}", flush=True)
                    replay.tool_use(current_tool, inp)

                elif block.type == ContentBlockType.TOOL_RESULT:
                    _show_result(
                        agent_type,
                        current_tool,
                        block.is_error,
                        block.result_content or "",
                        task_logger,
                        verbose,
                    )
                    if current_tool:
                        replay.tool_result(
                            current_tool, block.result_content or "", block.is_error
                        )
                    current_tool = None

        print("\n" + "-" * 70 + "\n")
        from agents.session import record_client_usage

        record_client_usage(client, spec_dir, "validation", agent_type=agent_type)
        outcome.result_error = _result_error(client)
        if outcome.result_error:
            debug_error(
                agent_type, f"Session ended on an error: {outcome.result_error}"
            )
            print(f"\n❌ {provider} session error: {outcome.result_error}")
        finished = not outcome.result_error
    finally:
        # Closed on every way out, an exception included: Session History
        # shows a red card instead of a session still recording.
        replay("end_session", status="completed" if finished else "failed")
    return outcome


def _show_result(
    agent_type: str,
    tool: str | None,
    is_error: bool,
    content: Any,
    task_logger: Any,
    verbose: bool,
) -> None:
    """Print and log one tool result."""
    text = str(content)
    if is_error:
        debug_error(agent_type, f"Tool error: {tool}", error=text[:200])
        print(f"   [Error] {text[:500]}", flush=True)
        if task_logger and tool:
            task_logger.tool_end(
                tool,
                success=False,
                result=text[:100],
                detail=text,
                phase=LogPhase.VALIDATION,
            )
        return
    debug_detailed(agent_type, f"Tool success: {tool}", result_length=len(text))
    print(f"   [Done] {text[:200]}" if verbose else "   [Done]", flush=True)
    if task_logger and tool:
        detail = text if tool in _DETAILED_TOOLS and len(text) < _MAX_DETAIL else None
        task_logger.tool_end(
            tool, success=True, detail=detail, phase=LogPhase.VALIDATION
        )
