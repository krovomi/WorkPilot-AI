"""The ``run_script`` definition, written for the tools this session has.

A function is described only when the session may use the tool behind it: a
reviewer that cannot write is not told about ``write`` and ``edit``. The script
could still name them, and ``executor.execute`` would refuse them as it refuses
the session's own calls.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .runner import MAX_CALLS, MAX_SECONDS

TOOL_NAME = "run_script"

#: Script function -> (the executor tool it calls, its line in the description).
_FUNCTIONS: tuple[tuple[str, str], ...] = (
    (
        "read_file",
        "await read(path, {offset, limit}) -> the file's text, paged like read_file",
    ),
    (
        "search_files",
        "await search(pattern, {directory, glob, offset}) -> 'path:line: text' lines",
    ),
    (
        "find_files",
        "await find(glob, {directory, offset}) -> matching paths, one per line",
    ),
    ("list_files", "await list(directory) -> the directory's entries"),
    ("write_file", "await write(path, content) -> writes the whole file"),
    (
        "write_file",
        "await edit(path, oldText, newText, {all}) -> replaces text that must occur once (or every time with all: true)",
    ),
    (
        "run_command",
        "await run(command, {cwd}) -> the command's output; throws when it fails",
    ),
)


def tool_definition(available: Iterable[str]) -> dict[str, Any]:
    """The definition offered to the model, for the executor tools ``available``."""
    names = set(available)
    lines = [line for tool, line in _FUNCTIONS if tool in names]
    others = sorted(
        name
        for name in names - {tool for tool, _ in _FUNCTIONS} - {TOOL_NAME}
        if name != "create_directory"
    )
    if others:
        lines.append(
            "await tool(name, args) -> any other tool of yours: " + ", ".join(others)
        )
    description = (
        "Run a short JavaScript script that chains your other tools in one step, "
        "instead of one turn per call. Use it when a task needs many calls: the "
        "same edit over many files, searching then reading only what matches, "
        "independent commands (lint, type check, tests) run together with "
        "Promise.all. For one or two calls, call the tool directly.\n"
        "Inside the script (top-level await, end with `return value`):\n- "
        + "\n- ".join(lines)
        + "\n- console.log(...) -> kept and shown with the result\n"
        "There is no require, no process, no fetch and no file access other than "
        "these functions; each call is checked like a direct call. Limits: "
        f"{MAX_CALLS} calls, {int(MAX_SECONDS // 60)} minutes. Return only what you "
        "need to read: the value is your next context."
    )
    return {
        "name": TOOL_NAME,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "The JavaScript to run; `return` the value you want back",
                }
            },
            "required": ["code"],
        },
    }


__all__ = ["TOOL_NAME", "tool_definition"]
