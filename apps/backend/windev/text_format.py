"""Reading an element saved in WinDev's text format, line by line.

The file is YAML, but not always valid YAML: the editor itself writes the odd
line a YAML parser refuses (``template_refs : []   -`` in a class saved by
WinDev 27). So nothing here depends on a YAML parser. The reader walks the
lines and keeps what an agent and a reviewer need:

* every ``code : |1+`` / ``code : |1-`` block, with the element, control or
  procedure it belongs to, its event ``type`` and its line span;
* the opaque values the editor alone produces — ``internal_properties``,
  ``identifier``, ``procedure_id`` — which an agent must never write.

A block scalar with indentation indicator 1 holds the lines indented one
space deeper than its key; a blank line belongs to the block, the first
non-blank line indented at or above the key ends it.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .files import TEXT_HEADER

__all__ = [
    "CodeBlock",
    "TextElement",
    "OPAQUE_KEYS",
    "parse_text_element",
]

#: Keys whose values only the editor can produce.
OPAQUE_KEYS = ("internal_properties", "identifier", "procedure_id")

_KEY_RE = re.compile(
    r"^(?P<indent> *)(?P<dash>- +)?(?P<key>[a-z_]+) :(?: (?P<value>.*))?$"
)
_DASH_RE = re.compile(r"^ *-\s*$")
_BLOCK_RE = re.compile(r"^\|(?P<indicator>\d)?(?P<chomp>[+-])?\s*$")


@dataclass(frozen=True)
class CodeBlock:
    """One WLangage block: an event, a procedure, a class declaration."""

    owner: str
    """The nearest ``name`` above the block: procedure, control or element."""
    event_type: str
    """The ``type`` written after the block (the event code), or ""."""
    start: int
    """1-based line of the ``code :`` key."""
    end: int
    """1-based last line of the block's content (``start`` when empty)."""
    header: str
    """The block indicator as written: ``|1+``, ``|1-``…"""
    code: str

    @property
    def lines(self) -> int:
        return len(self.code.splitlines())


@dataclass
class TextElement:
    """What a text-format element says about itself and its code."""

    name: str = ""
    major_version: int | None = None
    element_type: str = ""
    blocks: list[CodeBlock] = field(default_factory=list)
    opaque: dict[str, Counter[str]] = field(default_factory=dict)
    """Key -> the multiset of values it takes in the file."""
    header_ok: bool = True

    @property
    def code_lines(self) -> int:
        return sum(block.lines for block in self.blocks)


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse_text_element(text: str) -> TextElement:
    """Parse ``text``; a file that is not in the text format has ``header_ok`` False."""
    lines = text.splitlines()
    element = TextElement(opaque={key: Counter() for key in OPAQUE_KEYS})
    element.header_ok = bool(lines) and lines[0].lstrip("﻿").startswith(TEXT_HEADER)
    names: list[tuple[int, str]] = []  # (indent, name) of the enclosing nodes
    in_info = False
    i = 0
    while i < len(lines):
        line = lines[i]
        match = _KEY_RE.match(line)
        if not match:
            if _DASH_RE.match(line):
                # A new list item: the names of the previous one are closed.
                names = [(ind, n) for ind, n in names if ind <= _indent(line)]
            i += 1
            continue
        key_indent = len(match.group("indent")) + len(match.group("dash") or "")
        key, value = match.group("key"), (match.group("value") or "").strip()
        if key_indent == 0:
            in_info = key == "info"
        names = [(ind, n) for ind, n in names if ind <= key_indent]
        if match.group("dash"):
            names = [(ind, n) for ind, n in names if ind < key_indent]
        if key == "name":
            names = [(ind, n) for ind, n in names if ind < key_indent]
            names.append((key_indent, value))
            if in_info and not element.name:
                element.name = value
        elif in_info and key == "major_version" and value.isdigit():
            element.major_version = int(value)
        elif in_info and key == "type" and not element.element_type:
            element.element_type = value
        elif key in OPAQUE_KEYS and value:
            element.opaque[key][value] += 1
        block = _BLOCK_RE.match(value) if key == "code" else None
        if not block:
            i += 1
            continue
        step = int(block.group("indicator") or 1)
        body: list[str] = []
        j = i + 1
        while j < len(lines):
            candidate = lines[j]
            if candidate.strip() and _indent(candidate) <= key_indent:
                break
            body.append(candidate[key_indent + step :] if candidate.strip() else "")
            j += 1
        # Trailing blank lines are the chomping's business, not code.
        while body and not body[-1].strip():
            body.pop()
        event_type = ""
        if j < len(lines):
            after = _KEY_RE.match(lines[j])
            if after and after.group("key") == "type":
                event_type = (after.group("value") or "").strip()
        owner = names[-1][1] if names else element.name
        element.blocks.append(
            CodeBlock(
                owner=owner,
                event_type=event_type,
                start=i + 1,
                end=i + 1 + len(body),
                header=value,
                code="\n".join(body),
            )
        )
        i = j
    return element
