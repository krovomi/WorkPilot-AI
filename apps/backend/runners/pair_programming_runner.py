"""Pair Programming Runner — AI Pair Programming Mode (Feature 10).

Spawned by the Electron main process. Implements the AI's portion of a
pair-programming session while streaming structured JSON events to stdout.

Usage:
    python pair_programming_runner.py \\
        --project-dir /path/to/project \\
        --project-id proj-1 \\
        --session-id pair_1234567890 \\
        --goal "Add user authentication" \\
        --dev-scope "Frontend login/register components" \\
        --ai-scope "Backend auth API + integration tests" \\
        --messages-file /tmp/pair_session_messages.json

The runner reads --messages-file for the developer's messages while the AI
works, and gives them to the AI as the next turn once its current step ends.

Output (one JSON object per line):
    {"type": "status", "status": "planning", "message": "..."}
    {"type": "stream", "content": "..."}
    {"type": "action", "action_type": "file_created", "file_path": "...", "description": "..."}
    {"type": "action", "action_type": "file_modified", "file_path": "...", "description": "..."}
    {"type": "conflict", "file_path": "...", "message": "..."}
    {"type": "done", "summary": "..."}
    {"type": "error", "message": "..."}
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Structured output helpers
# ---------------------------------------------------------------------------


def emit(event: dict) -> None:
    """Emit a JSON event to stdout and flush immediately."""
    print(json.dumps(event), flush=True)


def emit_status(status: str, message: str) -> None:
    emit({"type": "status", "status": status, "message": message})


def emit_stream(content: str) -> None:
    emit({"type": "stream", "content": content})


def emit_action(action_type: str, description: str, file_path: str = "") -> None:
    emit(
        {
            "type": "action",
            "action_type": action_type,
            "description": description,
            "file_path": file_path,
            "timestamp": datetime.now(UTC).isoformat(),
        }
    )


def emit_conflict(file_path: str, message: str) -> None:
    emit({"type": "conflict", "file_path": file_path, "message": message})


def emit_done(summary: str) -> None:
    emit({"type": "done", "summary": summary})


def emit_error(message: str) -> None:
    emit({"type": "error", "message": message})


# ---------------------------------------------------------------------------
# Message file helpers (bidirectional communication)
# ---------------------------------------------------------------------------


def read_pending_messages(messages_file: str) -> list[dict]:
    """Read and clear the developer's pending messages (the app appends them)."""
    try:
        with open(messages_file, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    messages = data.get("pending") if isinstance(data, dict) else None
    if not isinstance(messages, list) or not messages:
        return []
    try:
        with open(messages_file, "w", encoding="utf-8") as f:
            json.dump({"pending": []}, f)
    except OSError:
        return []  # left in the file, read again next time
    return [m for m in messages if isinstance(m, dict) and m.get("content")]


#: The tool names each provider gives a file write, an edit and a command:
#: the Claude SDK's, `ToolExecutor`'s, and the older editor names.
_CREATE_TOOLS = frozenset({"Write", "write_file", "create_file"})
_EDIT_TOOLS = frozenset({"Edit", "MultiEdit", "edit_file", "str_replace_editor"})
_COMMAND_TOOLS = frozenset({"Bash", "run_command", "bash"})

#: How often the messages file is read while the AI is working, in seconds.
MESSAGE_POLL_SECONDS = 5.0


def _report_tool_use(tool_name: str, tool_input: dict) -> str | None:
    """Emit what a tool call does to the project; the path it touched, if any."""
    file_path = str(tool_input.get("file_path") or tool_input.get("path") or "")
    if tool_name in _CREATE_TOOLS:
        emit_action("file_created", f"Created {file_path}", file_path)
        return file_path
    if tool_name in _EDIT_TOOLS:
        emit_action("file_modified", f"Modified {file_path}", file_path)
        return file_path
    if tool_name in _COMMAND_TOOLS:
        command = str(tool_input.get("command") or tool_input.get("cmd") or "")
        emit_action("command_run", f"Running: {command[:80]}")
    return None


def _developer_turn(messages: list[dict]) -> str:
    said = "\n".join(f"- {m['content']}" for m in messages)
    return (
        "The developer you are pairing with sent you this while you worked:\n"
        f"{said}\n\n"
        "Take it into account, continue your part of the work, and summarise "
        "what you changed."
    )


def _scope_conflicts(touched: list[str], dev_scope: str) -> list[str]:
    """Files the AI touched whose path names a word of the developer's scope."""
    words = {w.strip(".,;:()").lower() for w in dev_scope.split()}
    words = {w for w in words if len(w) > 4}
    return [
        path
        for path in dict.fromkeys(touched)
        if any(word in path.lower() for word in words)
    ]


async def run_pair_programming_session(
    project_dir: str,
    project_id: str,
    session_id: str,
    goal: str,
    dev_scope: str,
    ai_scope: str,
    messages_file: str,
) -> None:
    """Run the AI's half of a pair programming session."""
    from core.agent_client import ContentBlockType
    from core.client import create_agent_client
    from core.workflow_logger import workflow_logger
    from phase_config import get_phase_model, get_phase_thinking_budget

    emit_status("planning", "Analyzing project structure and planning AI scope...")

    prompt = f"""You are working as an AI pair programmer on a real codebase.

PROJECT DIRECTORY: {project_dir}
SESSION GOAL: {goal}

WORK SPLIT:
- Developer is working on: {dev_scope}
- YOU (AI) are responsible for: {ai_scope}

IMPORTANT RULES:
1. Focus ONLY on your assigned scope: {ai_scope}
2. Do NOT touch files in the developer's scope: {dev_scope}
3. After completing each major step, emit a brief summary of what you did
4. If you need clarification from the developer, ask a concise question and continue with your best assumption
5. Work systematically: analyze → plan → implement → verify

Steps:
1. First, briefly analyze the project structure relevant to your scope (list key files)
2. Plan your implementation (3-5 bullet points)
3. Implement each part, explaining what you're doing
4. After completing your work, provide a summary of all changes made

Begin now. Be systematic and thorough."""

    trace_id = workflow_logger.log_agent_start(
        "PairProgrammingAgent", "pair_programming", {"session_id": session_id}
    )
    emit_status("active", f"Starting AI implementation: {ai_scope}")

    try:
        # Resolved from the user's settings like every other coding session.
        spec_dir = Path(project_dir)
        client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=get_phase_model(spec_dir, "coding"),
            agent_type="coder",
            max_thinking_tokens=get_phase_thinking_budget(spec_dir, "coding"),
        )
        touched: list[str] = []
        waiting: list[dict] = []
        async with client:
            turn: str | None = prompt
            while turn is not None:
                await client.query(turn)
                last_check = time.monotonic()
                async for msg in client.receive_response():
                    if time.monotonic() - last_check >= MESSAGE_POLL_SECONDS:
                        last_check = time.monotonic()
                        arrived = read_pending_messages(messages_file)
                        if arrived:
                            waiting.extend(arrived)
                            emit_status(
                                "active",
                                "Message received: the AI reads it when its "
                                "current step ends.",
                            )
                    for block in msg.content:
                        if block.type == ContentBlockType.TEXT and block.text:
                            emit_stream(block.text)
                        elif block.type == ContentBlockType.TOOL_USE:
                            path = _report_tool_use(
                                block.tool_name or "", block.tool_input or {}
                            )
                            if path:
                                touched.append(path)
                waiting.extend(read_pending_messages(messages_file))
                turn = _developer_turn(waiting) if waiting else None
                waiting = []

        for path in _scope_conflicts(touched, dev_scope):
            emit_conflict(
                path,
                f"The AI changed {path}, which looks like part of your scope. "
                "Review recommended.",
            )
        workflow_logger.log_agent_end(
            "PairProgrammingAgent", "pair_programming", "success", trace_id=trace_id
        )
        emit_done(
            f"Completed AI scope: {ai_scope}. See chat for implementation details."
        )
    except Exception as e:  # noqa: BLE001 - the session's only report is its stream
        logger.exception("pair programming session failed")
        workflow_logger.log_agent_end(
            "PairProgrammingAgent", "pair_programming", "error", trace_id=trace_id
        )
        emit_error(f"Session failed: {e}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Pair Programming Runner")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--goal", required=True)
    parser.add_argument("--dev-scope", required=True)
    parser.add_argument("--ai-scope", required=True)
    parser.add_argument("--messages-file", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    asyncio.run(
        run_pair_programming_session(
            project_dir=args.project_dir,
            project_id=args.project_id,
            session_id=args.session_id,
            goal=args.goal,
            dev_scope=args.dev_scope,
            ai_scope=args.ai_scope,
            messages_file=args.messages_file,
        )
    )


if __name__ == "__main__":
    # Launched without PYTHONPATH: put the backend on the path for core.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
