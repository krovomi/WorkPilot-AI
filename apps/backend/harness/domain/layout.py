"""Stable first: a prompt is a run of segments ordered by how long they hold.

Every provider that caches a prompt caches a prefix: OpenAI and its compatibles,
DeepSeek and Gemini by matching the first tokens of the request, Anthropic by
matching whole blocks up to a breakpoint. Either way, a byte that changes
early costs everything after it. The order that keeps the shared part shared
is therefore a rule, not a habit: what every task shares comes first, then
what one project shares, then one task, one session, one turn.

A segment says which of those it is; ``assemble`` joins them and refuses a
segment that would sit before one more stable than itself, so a volatile line
cannot slip to the top of a prompt unnoticed.

Pure, table-tested in ``tests/harness/test_layout.py``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from enum import IntEnum


class Stability(IntEnum):
    """Who shares a segment, from the widest circle to the narrowest."""

    STATIC = 0  # every task this installation runs, on a given provider
    PROJECT = 1  # every task of one project
    TASK = 2  # every session of one task
    SESSION = 3  # every call of one session
    TURN = 4  # one call


@dataclass(frozen=True)
class Segment:
    """One piece of a prompt, and how long it holds.

    The text carries its own separator, as the prompts built before this
    module did: the assembler adds nothing, so a segment that is already
    byte-stable stays so.
    """

    name: str
    text: str
    stability: Stability


class LayoutError(ValueError):
    """A segment sits before one more stable than itself."""


def ordered(segments: Iterable[Segment]) -> list[Segment]:
    """The non-empty segments, checked for order.

    An empty segment (an optional section that does not apply) holds no
    place, so it constrains nothing.
    """
    kept = [segment for segment in segments if segment.text]
    for before, after in zip(kept, kept[1:]):
        if after.stability < before.stability:
            raise LayoutError(
                f"{after.name!r} ({after.stability.name.lower()}) is placed after "
                f"{before.name!r} ({before.stability.name.lower()}): a prompt "
                "goes from the most stable segment to the least, or the "
                "shared part of the prefix stops being shared"
            )
    return kept


def assemble(segments: Iterable[Segment]) -> str:
    """The prompt: the segments joined in order, once the order is checked."""
    return "".join(segment.text for segment in ordered(segments))


def shared_prefix(segments: Iterable[Segment], *, up_to: Stability) -> str:
    """The part of the prompt every holder of ``up_to`` shares.

    ``up_to=Stability.PROJECT`` is what two tasks of one project send
    identically, whatever their worktree: the leading segments of that
    class or a more stable one.
    """
    prefix: list[str] = []
    for segment in ordered(segments):
        if segment.stability > up_to:
            break
        prefix.append(segment.text)
    return "".join(prefix)
