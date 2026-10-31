"""How a tool call reads in the live activity feed and the streaming view.

Provider-agnostic: the tool names and argument keys of Claude (Edit, Write,
Bash) and of the other providers (write_file, run_command...) are matched
alike, so the feed and the left frame of the streaming view follow any agent.
Pure functions, read by ``agents.session``.
"""

from typing import Any

# Maximum length for the tool-input string shown in the live activity feed
# and task logs. Generous enough that real-world commands and file paths are
# displayed in full so the user can see exactly what the agent is doing; only
# pathological inputs (e.g. an inline heredoc embedding a whole file) are
# trimmed so they can't flood the console or task log.
MAX_TOOL_INPUT_DISPLAY = 2000


def format_tool_input_display(inp: dict[str, Any] | None) -> str | None:
    """Build a human-readable one-liner describing a tool call's input.

    Commands and paths are shown in full (up to MAX_TOOL_INPUT_DISPLAY) so the
    activity feed reveals the complete command rather than a truncated head.
    For over-long inputs we keep the head of a command and the tail of a path
    (the filename is the most useful part of a long path).
    """
    if not inp:
        return None
    if "pattern" in inp:
        return f"pattern: {inp['pattern']}"
    if "file_path" in inp:
        fp = str(inp["file_path"])
        if len(fp) > MAX_TOOL_INPUT_DISPLAY:
            fp = "..." + fp[-(MAX_TOOL_INPUT_DISPLAY - 3) :]
        return fp
    if "command" in inp:
        cmd = str(inp["command"])
        if len(cmd) > MAX_TOOL_INPUT_DISPLAY:
            cmd = cmd[: MAX_TOOL_INPUT_DISPLAY - 3] + "..."
        return cmd
    if "path" in inp:
        return str(inp["path"])
    return None


# Tool names that write/modify a file, across every provider. Claude SDK uses
# Edit/Write; non-Claude providers (Copilot, Windsurf...) use the tools defined
# in core/runtimes/tool_executor.py (write_file, create_file...) plus common
# editor variants. Matched case-insensitively so the live streaming view stays
# provider-agnostic (otherwise the left frame never leaves "waiting for code
# changes" for non-Claude runs).
_FILE_WRITE_TOOL_NAMES = frozenset(
    {
        "edit",
        "write",
        "write_file",
        "create",
        "create_file",
        "edit_file",
        "str_replace",
        "str_replace_editor",
        "apply_patch",
    }
)

# Tool names that run a shell command, across every provider. Claude SDK uses
# Bash; non-Claude providers use run_command (tool_executor.py) and variants.
_COMMAND_TOOL_NAMES = frozenset(
    {
        "bash",
        "shell",
        "run_command",
        "run",
        "execute_command",
        "command",
    }
)

# Candidate argument keys for a file path / file content / command, ordered by
# preference. Different providers name the same concept differently
# (file_path vs path, content vs new_string vs CodeContent...).
_FILE_PATH_KEYS = ("file_path", "path", "filename", "file")
_FILE_CONTENT_KEYS = ("content", "new_string", "new_str", "CodeContent", "text")
_COMMAND_KEYS = ("command", "cmd")


def is_command_tool(tool_name: str | None) -> bool:
    """Return True if the tool runs a shell command (any provider)."""
    if not tool_name:
        return False
    return tool_name.lower() in _COMMAND_TOOL_NAMES


def extract_streaming_file_change(
    tool_name: str | None, inp: dict[str, Any] | None
) -> tuple[str, str | None] | None:
    """Extract (file_path, content) for a file-write tool, or None.

    Provider-agnostic: recognises Claude (Edit/Write) and non-Claude
    (write_file, create_file, str_replace...) tool names so the live streaming
    view updates regardless of which agent backend is running.
    """
    if not tool_name or not inp or tool_name.lower() not in _FILE_WRITE_TOOL_NAMES:
        return None

    file_path = next(
        (str(inp[key]) for key in _FILE_PATH_KEYS if inp.get(key)),
        None,
    )
    if not file_path:
        return None

    content = next(
        (inp[key] for key in _FILE_CONTENT_KEYS if inp.get(key) is not None),
        None,
    )
    return file_path, (str(content) if content is not None else None)


def extract_streaming_command(
    tool_name: str | None, inp: dict[str, Any] | None
) -> str | None:
    """Extract the command string for a command tool, or None (any provider)."""
    if not is_command_tool(tool_name) or not inp:
        return None
    return next(
        (str(inp[key]) for key in _COMMAND_KEYS if inp.get(key)),
        None,
    )
