"""When to clear old tool results, and which: in batches, never a little each turn.

A tool result the model has already used is the cheapest thing to drop from a
conversation: the call that produced it stays, so the model can run it again.
But every clearing rewrites the conversation from the first message it touches,
and a provider that caches a prefix bills everything after that point again.
Clearing one old result per turn, as soon as the conversation crosses a budget,
pays that rewrite on every turn; clearing a batch, down to well under the
budget, pays it once and leaves room for many turns.

So a clearing happens only above ``trigger_chars``, goes down to
``target_chars``, and is skipped when it would free less than
``min_gain_chars``: a rewrite that frees little costs more than it saves.
It never touches what the caller protects (the system prompt, the task), the
``keep_recent`` latest messages (the work in progress, and any tool call still
waiting for its result), nor anything the caller does not mark clearable: a
tool result, or a past tool call whose long arguments (a whole file handed to a
write) can go while the call itself stays.

Pure, table-tested in ``tests/harness/test_policies.py``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class ClearingPolicy:
    trigger_chars: int
    target_chars: int
    keep_recent: int = 8
    min_gain_chars: int = 0

    @classmethod
    def for_budget(cls, budget_chars: int, *, keep_recent: int = 8) -> ClearingPolicy:
        """The policy for a conversation budget: clear down to 60 % of it, in
        one batch, and only when that frees a tenth of it."""
        return cls(
            trigger_chars=budget_chars,
            target_chars=int(budget_chars * 0.6),
            keep_recent=keep_recent,
            min_gain_chars=budget_chars // 10,
        )


@dataclass(frozen=True)
class Entry:
    """What the policy knows of one message: its size, and whether it may go."""

    chars: int
    clearable: bool  # a tool result or a past call the caller does not protect
    # What is left once cleared; ``None``: the marker that replaces a result.
    cleared_chars: int | None = None


def plan_clearing(
    entries: Sequence[Entry], policy: ClearingPolicy, *, marker_chars: int
) -> list[int]:
    """The indexes of the entries to clear now, oldest first, or none.

    ``marker_chars`` is the size of what replaces a cleared result, for an
    entry that does not say what it keeps (``cleared_chars``).
    """
    total = sum(entry.chars for entry in entries)
    if total <= policy.trigger_chars:
        return []
    cutoff = max(0, len(entries) - policy.keep_recent)
    chosen: list[int] = []
    gain = 0
    for index, entry in enumerate(entries[:cutoff]):
        if total - gain <= policy.target_chars:
            break
        left = marker_chars if entry.cleared_chars is None else entry.cleared_chars
        if not entry.clearable or entry.chars <= left:
            continue
        chosen.append(index)
        gain += entry.chars - left
    if gain < policy.min_gain_chars:
        return []
    return chosen
