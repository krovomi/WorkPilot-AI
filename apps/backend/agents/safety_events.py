"""A tool call, in the words of the anomaly detector.

The session stream names tools the way each provider does: ``Write`` and
``Bash`` for Claude, ``write_file`` and ``run_command`` for WorkPilot's own
loop, ``apply_patch`` for Codex, ``edit``/``bash`` for pi and OpenCode, and the
``mcp__server__tool`` names of MCP. This turns one call into the events
``security.anomaly_detector`` scores: file reads, writes and deletions, the
commands run, the remote hosts a command reaches, a write to the security
configuration, a call that failed.

A path inside the project is given relative to it (resolved, so
``src/../README.md`` is ``README.md``); one outside keeps its absolute form,
which is what the detector's traversal and system-path rules judge. Pure.
"""

from __future__ import annotations

import shlex
from pathlib import Path, PurePosixPath
from typing import Any

from security.anomaly_detector import EventType, remote_urls
from security.parser import split_command_segments
from security.path_guard import protected_config_target

from .tool_display import extract_streaming_command, extract_streaming_file_change

READ_TOOLS = frozenset(
    {"read", "read_file", "view", "view_file", "open_file", "notebookread", "cat"}
)
DELETE_TOOLS = frozenset({"delete", "delete_file", "remove_file", "rm"})
_PATH_KEYS = ("file_path", "path", "filename", "file", "notebook_path")
#: Commands whose operands are files they delete.
_DELETE_COMMANDS = frozenset({"rm", "unlink", "del", "erase", "remove-item", "rmdir"})

Event = tuple[str, dict[str, Any]]


def bare_tool_name(name: str | None) -> str:
    """``mcp__server__write_file`` and ``Write`` alike, lowercased."""
    return (name or "").rsplit("__", 1)[-1].lower()


def event_path(path: str, project_dir: Path | None) -> str:
    """The path as the detector should see it (see the module docstring)."""
    raw = str(path).strip()
    if project_dir is None or not raw:
        return raw
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = project_dir / candidate
    try:
        resolved = candidate.resolve()
        root = project_dir.resolve()
    except (OSError, RuntimeError, ValueError):
        return raw
    if resolved == root or resolved.is_relative_to(root):
        relative = PurePosixPath(*resolved.relative_to(root).parts).as_posix()
        return relative or "."
    return resolved.as_posix()


def _path_argument(arguments: dict[str, Any]) -> str | None:
    for key in _PATH_KEYS:
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _deleted_paths(command: str) -> list[str]:
    """The operands of ``rm``-like commands (and ``git rm``) in a shell line."""
    paths: list[str] = []
    for segment in split_command_segments(command):
        for piece in segment.split("|"):
            try:
                tokens = shlex.split(piece.strip())
            except ValueError:
                continue
            if not tokens:
                continue
            head = tokens[0].rsplit("/", 1)[-1].lower()
            operands = tokens[1:]
            if head == "git" and operands[:1] == ["rm"]:
                operands = operands[1:]
            elif head not in _DELETE_COMMANDS:
                continue
            paths.extend(t for t in operands if t and not t.startswith("-"))
    return paths


def call_events(
    name: str | None, arguments: Any, project_dir: Path | None
) -> list[Event]:
    """The events a tool call stands for (before its result is known)."""
    args = arguments if isinstance(arguments, dict) else {}
    bare = bare_tool_name(name)
    events: list[Event] = []

    command = extract_streaming_command(bare, args)
    if command:
        events.append((EventType.COMMAND_EXEC.value, {"command": command}))
        for url in remote_urls(command):
            events.append((EventType.NETWORK_REQUEST.value, {"url": url}))
        for target in _deleted_paths(command):
            events.append(
                (EventType.FILE_DELETE.value, {"path": event_path(target, project_dir)})
            )
        return events

    written = extract_streaming_file_change(bare, args)
    if written:
        path = event_path(written[0], project_dir)
        events.append((EventType.FILE_WRITE.value, {"path": path}))
        if protected_config_target(path):
            events.append((EventType.CONFIG_CHANGE.value, {"path": path}))
        return events

    target = _path_argument(args)
    if target and bare in READ_TOOLS:
        events.append(
            (EventType.FILE_READ.value, {"path": event_path(target, project_dir)})
        )
    elif target and bare in DELETE_TOOLS:
        events.append(
            (EventType.FILE_DELETE.value, {"path": event_path(target, project_dir)})
        )
    return events


def written_path(name: str | None, arguments: Any) -> str | None:
    """The file a write tool changes, as the call names it; None otherwise."""
    args = arguments if isinstance(arguments, dict) else {}
    written = extract_streaming_file_change(bare_tool_name(name), args)
    return written[0] if written else None


__all__ = [
    "DELETE_TOOLS",
    "READ_TOOLS",
    "bare_tool_name",
    "call_events",
    "event_path",
    "written_path",
]
