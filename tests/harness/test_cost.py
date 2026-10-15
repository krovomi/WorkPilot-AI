"""harness.domain.cost: the price of a call and the budget rule, for every provider."""

from __future__ import annotations

import pytest
from harness.domain import CallUsage, TokenPrices, call_cost, calls_cost, over_budget

# $3 input, $15 output, $0.30 cache read, $3.75 cache write per million tokens.
PRICES = TokenPrices(input=3.0, output=15.0, cache_read=0.30, cache_write=3.75)


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        # 100 uncached + 9 000 read + 400 written, 50 out.
        (
            CallUsage(9_500, 9_000, 400, 50),
            (100 * 3.0 + 50 * 15.0 + 9_000 * 0.30 + 400 * 3.75) / 1_000_000,
        ),
        # No cache reported: the whole prompt at the input rate, never less.
        (CallUsage(2_000, None, None, 10), (2_000 * 3.0 + 10 * 15.0) / 1_000_000),
        # Reasoning is inside the output in every format: not charged twice.
        (
            CallUsage(1_000, None, None, 100, reasoning=60),
            (1_000 * 3.0 + 100 * 15.0) / 1_000_000,
        ),
        # Prompt size unknown: no estimate.
        (CallUsage(None, None, None, 10), None),
    ],
)
def test_call_cost(usage, expected):
    cost = call_cost(usage, PRICES)
    if expected is None:
        assert cost is None
    else:
        assert cost == pytest.approx(expected)


def test_calls_cost_needs_a_price_and_a_measured_call():
    calls = [CallUsage(1_000, None, None, 0), CallUsage(None, None, None, 5)]
    assert calls_cost(calls, PRICES) == pytest.approx(1_000 * 3.0 / 1_000_000)
    assert calls_cost(calls, None) is None
    assert calls_cost([], PRICES) is None


@pytest.mark.parametrize(
    ("spent", "cap", "stops"),
    [
        (5.0, 5.0, True),
        (5.01, 5.0, True),
        (4.99, 5.0, False),
        # Unknown spend or no cap never stops a session.
        (None, 5.0, False),
        (100.0, None, False),
        (100.0, 0.0, False),
    ],
)
def test_over_budget(spent, cap, stops):
    assert over_budget(spent, cap) is stops
