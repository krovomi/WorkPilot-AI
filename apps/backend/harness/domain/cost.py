"""What calls cost, and when a session has spent enough.

Prices are data (``TokenPrices``, per million tokens), looked up outside the
domain; the arithmetic and the stopping rule live here, the same for every
provider. Pure, table-tested in ``tests/harness/test_cost.py``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .usage import CallUsage


@dataclass(frozen=True)
class TokenPrices:
    """USD per million tokens, by kind of token."""

    input: float
    output: float
    cache_read: float = 0.0
    cache_write: float = 0.0


def call_cost(usage: CallUsage, prices: TokenPrices) -> float | None:
    """The cost of one call, or None when its prompt size is unknown.

    A provider that does not report its cache is charged the full input rate
    on the whole prompt: an estimate that errs high, never low. Reasoning is
    not charged apart: every format counts it inside the output.
    """
    uncached = usage.uncached
    if uncached is None:
        return None
    return (
        uncached * prices.input
        + (usage.output or 0) * prices.output
        + (usage.cache_read or 0) * prices.cache_read
        + (usage.cache_write or 0) * prices.cache_write
    ) / 1_000_000


def calls_cost(calls: Iterable[CallUsage], prices: TokenPrices | None) -> float | None:
    """The cost of a session's calls; None when no price is known or no call is measured."""
    if prices is None:
        return None
    costs = [
        cost for cost in (call_cost(call, prices) for call in calls) if cost is not None
    ]
    return sum(costs) if costs else None


def over_budget(spent_usd: float | None, cap_usd: float | None) -> bool:
    """Whether a session has reached its cap.

    An unknown spend, or no cap, never stops a session: the harness does not
    stop work on a number it cannot measure.
    """
    return (
        spent_usd is not None
        and cap_usd is not None
        and cap_usd > 0
        and spent_usd >= cap_usd
    )
