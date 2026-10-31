"""The first JSON document in a model's answer, read leniently.

Models wrap JSON in a fence, a sentence before or a sentence after; every
reader of a model's JSON (the plan recovery, docintel, the insight extractor,
runners) goes through the one scanner here. Standard library only.
"""

from __future__ import annotations

import json
from typing import Any


def extract_json_document(text: str) -> Any | None:
    """The first complete JSON object or array in ``text``, or ``None``.

    Handles the three ways a model hands back JSON that ``json.loads`` refuses:
    a ```json fence, a sentence before it ("Here is the plan:"), and a sentence
    after it. Scans with a brace/bracket depth counter that ignores everything
    inside string literals, so a `"description": "map[0] of {x}"` does not close
    the document early.

    Returns the *first* complete document rather than the largest: a planner's
    response that shows the plan and then an example of one subtask should be
    read as the plan.
    """
    if not text:
        return None

    # A whole document that already parses needs none of this.
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except (ValueError, TypeError):
        pass

    for start, opener in _document_starts(stripped):
        closer = "}" if opener == "{" else "]"
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(stripped)):
            char = stripped[i]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(stripped[start : i + 1])
                    except ValueError:
                        break  # this candidate is malformed; try the next one
    return None


def _document_starts(text: str) -> list[tuple[int, str]]:
    """Offsets where a JSON document plausibly begins, best first.

    A fenced block is the strongest signal a model can give about which braces
    it meant, so those offsets come first; bare offsets follow in reading order.
    """
    starts: list[tuple[int, str]] = []
    seen: set[int] = set()

    for fence in ("```json", "```JSON", "```"):
        cursor = 0
        while (opening := text.find(fence, cursor)) != -1:
            body = opening + len(fence)
            for offset in range(body, min(body + 200, len(text))):
                if text[offset] in "{[":
                    if offset not in seen:
                        seen.add(offset)
                        starts.append((offset, text[offset]))
                    break
                if not text[offset].isspace():
                    break
            cursor = body

    for offset, char in enumerate(text):
        if char in "{[" and offset not in seen:
            seen.add(offset)
            starts.append((offset, char))

    return starts
