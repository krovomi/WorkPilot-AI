"""The calls a script made, written after its result and read back by the safety watch.

A ``run_script`` call is one tool call in the session stream, but the safety
watch (``agents.safety_watch``) scores what a session does: the files written,
the commands run, the hosts reached. So the result of a script ends with its
calls, one JSON object per line after ``MARKER``, holding only what the watch
reads (the tool, its path, its command). The watch takes the last block of the
result, the one the runner writes after the script's own value: a script that
prints a block of its own can add calls to its record, never hide one.

Pure.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

MARKER = "[WorkPilot script calls]"

#: Argument keys kept in the record, under the name the watch reads.
_KEPT = {
    "path": "path",
    "file_path": "path",
    "filepath": "path",
    "file": "path",
    "command": "command",
    "cmd": "command",
}
#: The longest value kept for one key.
_MAX_VALUE = 500


@dataclass
class InnerCall:
    tool: str
    arguments: dict[str, Any]
    #: False when the call failed or was refused: nothing was done.
    ok: bool = True

    def record(self) -> dict[str, Any]:
        kept: dict[str, Any] = {"tool": self.tool}
        for key, name in _KEPT.items():
            value = self.arguments.get(key)
            if isinstance(value, str) and value and name not in kept:
                kept[name] = value[:_MAX_VALUE]
        if not self.ok:
            kept["ok"] = False
        return kept


def trailer(calls: list[InnerCall]) -> str:
    """The block the runner appends to a script's result ("" for no call)."""
    if not calls:
        return ""
    lines = [MARKER]
    lines.extend(json.dumps(call.record(), ensure_ascii=False) for call in calls)
    return "\n".join(lines)


def inner_calls(result: Any) -> list[tuple[str, dict[str, str], bool]]:
    """``(tool, arguments, ok)`` for each call recorded in a script's result."""
    if not isinstance(result, str):
        if isinstance(result, list):
            result = "\n".join(
                str(block.get("text", "")) if isinstance(block, dict) else str(block)
                for block in result
            )
        else:
            return []
    at = result.rfind(MARKER)
    if at < 0:
        return []
    calls: list[tuple[str, dict[str, str], bool]] = []
    for line in result[at + len(MARKER) :].splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or not isinstance(record.get("tool"), str):
            continue
        arguments = {
            key: value
            for key, value in record.items()
            if key in ("path", "command") and isinstance(value, str)
        }
        calls.append((record["tool"], arguments, record.get("ok") is not False))
    return calls


__all__ = ["MARKER", "InnerCall", "inner_calls", "trailer"]
