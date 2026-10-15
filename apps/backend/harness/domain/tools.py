"""One tool set per session: one order, one serialization, one weight.

Every provider that caches a prompt caches the tool definitions with it, ahead
of the conversation: OpenAI and the compatible providers send them before the
messages, Anthropic caches them right after the system prompt, a text-mode
client (Windsurf over gRPC) writes them into the system prompt itself. A tool
set that changes during a session — a tool added, the same tools in another
order, the same schema with its keys in another order — rewrites everything
after it, and the whole conversation is paid again.

So a session's tools have one canonical form: sorted by name, every object's
keys sorted at every depth, every list in its own order (the order of a list is
data). Two sessions given the same tools, in whatever order and from whatever
source, send the same bytes. ``ToolSet`` carries that form, its fingerprint and
its size, from which the caller estimates its weight in the prefix with its own
ratio of characters per token.

Within a session the fingerprint does not change: ``hold`` keeps the set the
session started with and refuses another (``ToolSetChanged``).

Pure, table-tested in ``tests/harness/test_tools.py``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any


def _sorted_keys(value: Any) -> Any:
    """``value`` with every object's keys sorted, at every depth."""
    if isinstance(value, Mapping):
        return {key: _sorted_keys(value[key]) for key in sorted(value)}
    if isinstance(value, list | tuple):
        return [_sorted_keys(item) for item in value]
    return value


def _dumps(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )


def canonical_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    """One tool definition in canonical form.

    An absent ``description`` or ``parameters`` takes the value every loop
    sends in its place, so a definition that omits them and one that spells
    them out are the same tool.
    """
    return _sorted_keys(
        {
            **tool,
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {"type": "object", "properties": {}}),
        }
    )


def canonical_tools(tools: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The tools in canonical form, sorted by name.

    Two definitions under one name (which a provider refuses, or resolves its
    own way) keep a fixed order too: by their serialized form.
    """
    canonical = [canonical_tool(tool) for tool in tools]
    return sorted(canonical, key=lambda tool: (str(tool["name"]), _dumps(tool)))


def serialize(tools: Iterable[Mapping[str, Any]]) -> str:
    """The one serialization of a tool set: canonical, sorted, compact JSON."""
    return _dumps(canonical_tools(tools))


@dataclass(frozen=True)
class ToolSet:
    """A session's tools in canonical form, and what identifies them."""

    tools: tuple[dict[str, Any], ...]
    fingerprint: str
    chars: int

    @classmethod
    def of(cls, tools: Iterable[Mapping[str, Any]]) -> ToolSet:
        canonical = canonical_tools(tools)
        text = _dumps(canonical)
        return cls(
            tools=tuple(canonical),
            fingerprint=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            chars=len(text),
        )

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(str(tool["name"]) for tool in self.tools)

    def tokens(self, chars_per_token: int) -> int:
        """The estimated weight of the set in the prefix, rounded up."""
        return (self.chars + chars_per_token - 1) // chars_per_token


class ToolSetChanged(ValueError):
    """A session was offered other tools than the ones it started with."""


def hold(held: ToolSet | None, offered: ToolSet) -> ToolSet:
    """The tools a session sends: the set it started with.

    ``held`` is None while the session has none: the offered set becomes its
    own. The same fingerprint is the same set. Any other set is refused, so the
    caller keeps ``held`` and the cache it has paid for.
    """
    if held is None:
        return offered
    if offered.fingerprint == held.fingerprint:
        return held
    added = sorted(set(offered.names) - set(held.names))
    removed = sorted(set(held.names) - set(offered.names))
    if added or removed:
        change = f"added {added or 'none'}, removed {removed or 'none'}"
    else:
        change = "same names, other schemas"
    raise ToolSetChanged(f"the session's tools changed ({change})")
