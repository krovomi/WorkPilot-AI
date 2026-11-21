"""The corrections' spend: tokens as each provider reports them, money never guessed."""

from __future__ import annotations

import pytest
from design_to_code.budget import (
    FLAT_RATE,
    PRICED,
    UNKNOWN,
    Pricing,
    Spend,
    Usage,
    estimate_usage,
    read_usage,
)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        # Anthropic's answer, and the SDK's usage dict on its own.
        (
            {
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_creation_input_tokens": 5,
                    "cache_read_input_tokens": 7,
                }
            },
            Usage(100, 20, 5, 7),
        ),
        ({"input_tokens": 3, "output_tokens": True}, Usage(3, 0)),
        # OpenAI: the cached tokens are part of the prompt's.
        (
            {
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 9,
                    "prompt_tokens_details": {"cached_tokens": 10},
                }
            },
            Usage(40, 9, cache_read_tokens=10),
        ),
        ({"usage": {"prompt_tokens": 4, "completion_tokens": -1}}, Usage(4, 0)),
        # Gemini, thoughts counted as output.
        (
            {
                "usageMetadata": {
                    "promptTokenCount": 30,
                    "candidatesTokenCount": 6,
                    "thoughtsTokenCount": 4,
                    "cachedContentTokenCount": 50,
                }
            },
            Usage(0, 10, cache_read_tokens=30),
        ),
        # Ollama's /api/generate.
        ({"prompt_eval_count": 12, "eval_count": 8}, Usage(12, 8)),
        ({"eval_count": 2}, Usage(0, 2)),
    ],
)
def test_each_provider_shape_is_read(payload, expected) -> None:
    assert read_usage(payload) == expected


@pytest.mark.parametrize(
    "payload", [None, "text", [], {}, {"usage": "x"}, {"usageMetadata": None}]
)
def test_an_answer_without_usage_reports_none(payload) -> None:
    assert read_usage(payload) is None


def test_the_estimate_counts_text_and_picture_and_says_so() -> None:
    usage = estimate_usage("a" * 9, (750, 2), "b" * 4)
    assert usage == Usage(3 + 2, 1, estimated=True) and usage.total == 6
    assert estimate_usage("", (-5, 10), "").total == 0


def test_a_priced_spend_counts_cost_and_stops_before_the_budget() -> None:
    spend = Spend(Pricing(PRICED, lambda u: u.total / 1000))
    assert spend.exhausted(1000, 1.0) is None
    assert spend.add(Usage(300, 100, 50, 50)) == (500, 0.5)
    assert spend.tokens == 500 and spend.known_cost == 0.5
    # Another correction as large as this one would reach 1000 tokens: allowed.
    assert spend.exhausted(1000, 0) is None
    # Not past 999 tokens; nor past $0.9 of cost.
    assert spend.exhausted(999, 0) == "tokens"
    assert spend.exhausted(0, 0.9) == "cost"
    assert spend.exhausted(0, 0) is None
    data = spend.as_dict(1000, 0.9)
    assert data["cost_status"] == PRICED and data["cost_usd"] == 0.5
    assert data["cost_budget_checked"] and not data["estimated"]
    assert (data["input_tokens"], data["output_tokens"]) == (400, 100)


def test_an_unknown_cost_is_never_invented_nor_enforced() -> None:
    spend = Spend()
    assert spend.add(Usage(10, 10, estimated=True)) == (20, None)
    assert spend.known_cost is None and spend.exhausted(0, 0.0001) is None
    data = spend.as_dict(100, 1.0)
    assert data["cost_status"] == UNKNOWN and data["cost_usd"] is None
    assert not data["cost_budget_checked"] and data["estimated"]
    # A status without a price function is unknown too.
    assert Spend(Pricing(PRICED)).known_cost is None


def test_a_flat_rate_costs_nothing_a_token() -> None:
    spend = Spend(Pricing(FLAT_RATE, lambda u: 0.0))
    assert spend.add(Usage(1, 1)) == (2, 0.0)
    assert spend.as_dict(0, 1.0)["cost_usd"] == 0.0
