"""The pricing catalog prices a model by its own row, never by a neighbour's.

The session cap (``AUTO_CLAUDE_MAX_BUDGET_USD``) prices every non-SDK session
from this catalog: a model resolved to another row's price is a cap off by
that ratio, silently. An unknown model is reported and left uncapped instead.
"""

from __future__ import annotations

import pytest
from cost_intelligence.catalog import (
    UNPRICED_MODELS,
    UNPRICED_PROVIDERS,
    ModelPricing,
    PricingCatalog,
)
from models_registry import REGISTRY


def _catalog(*keys: str) -> PricingCatalog:
    catalog = PricingCatalog()
    for price, key in enumerate(keys, start=1):
        catalog.add_pricing(ModelPricing(provider="acme", model=key, input=price))
    return catalog


@pytest.mark.parametrize("keys", [("m-5", "m-5-mini"), ("m-5-mini", "m-5")])
@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("m-5", "m-5"),
        # A snapshot or a release tag of a listed model takes its price.
        ("m-5-20251101", "m-5"),
        ("m-5-2025-08-07", "m-5"),
        ("m-5-0709", "m-5"),
        ("m-5-001", "m-5"),
        ("m-5-latest", "m-5"),
        ("m-5-preview-06-05", "m-5"),
        ("m-5-0309-non-reasoning", "m-5"),
        ("m-5-v1:0", "m-5"),
        ("m-5-20250929-v1:0", "m-5"),
        ("m-5@20251101", "m-5"),
        ("m-5:70b", "m-5"),
        ("m-5[1m]", "m-5"),
        # The longest key wins, whatever the order the keys were added in.
        ("m-5-mini", "m-5-mini"),
        ("m-5-mini-2025-08-07", "m-5-mini"),
        # A later version or another variant is another model: no price,
        # rather than the price of the model it extends.
        ("m-5.5", None),
        ("m-5-5", None),
        ("m-5-5-20261001", None),
        ("m-5-1-fast", None),
        ("m-50", None),
        ("m-5-nano", None),
        ("m-5-pro", None),
        # A key never prices a shorter id.
        ("m", None),
        ("", None),
    ],
)
def test_a_model_resolves_to_its_own_row(keys, model, expected):
    pricing = _catalog(*keys).get_pricing("acme", model)
    assert (pricing.model if pricing else None) == expected


@pytest.mark.parametrize(
    ("provider", "model", "expected"),
    [
        # Each resolved to an older or smaller model's row before.
        ("openai", "gpt-5.5", "gpt-5.5"),
        ("openai", "gpt-4.1-mini", "gpt-4.1-mini"),
        ("openai", "gpt-4", "gpt-4"),
        ("grok", "grok-4.3", "grok-4.3"),
        ("anthropic", "claude-opus-5-5", "claude-opus-5-5"),
        ("anthropic", "claude-fable-5-1", "claude-fable-5-1"),
        # Provider ids carrying a snapshot or a version.
        ("anthropic", "claude-opus-4-5-20251101", "claude-opus-4-5-20251101"),
        ("google", "gemini-3.1-pro-preview", "gemini-3.1-pro"),
        ("grok", "grok-4.20-0309-reasoning", "grok-4.20"),
        ("aws", "anthropic.claude-opus-4-6-v1", "anthropic.claude-opus-4-6"),
        ("mistral", "codestral-2508", "codestral"),
        # Nothing to resolve to: no price, rather than a neighbour's.
        ("openai", "gpt-5.5-mini", None),
        ("anthropic", "claude", None),
        ("deepseek", "deepseek-v3", None),
    ],
)
def test_default_catalog_lookups(provider, model, expected):
    pricing = PricingCatalog().get_pricing(provider, model)
    assert (pricing.model if pricing else None) == expected


def test_newest_claude_rows_match_the_price_sheet():
    catalog = PricingCatalog()
    opus = catalog.get_pricing("anthropic", "claude-opus-5-5")
    sonnet = catalog.get_pricing("anthropic", "claude-sonnet-5-5")
    assert opus is not None and sonnet is not None
    assert (opus.input, opus.output, opus.cache_write, opus.cache_read) == (
        4.0,
        20.0,
        5.0,
        0.20,
    )
    assert (sonnet.input, sonnet.output, sonnet.cache_read) == (2.0, 10.0, 0.10)


def test_an_unlisted_cache_price_bills_as_input():
    # gpt-5.5-pro has no cached-input discount: a cached token costs input.
    pricing = PricingCatalog().get_pricing("openai", "gpt-5.5-pro")
    assert pricing is not None
    assert pricing.cache_read == pricing.input
    assert pricing.cache_write == pricing.input


@pytest.mark.parametrize(
    "entry",
    [e for e in REGISTRY if e.provider not in UNPRICED_PROVIDERS],
    ids=lambda e: f"{e.provider}/{e.model_id}",
)
def test_every_offered_model_is_priced_or_says_why_not(entry):
    """Done means: a price, or a reason in UNPRICED_MODELS — never both."""
    pricing = PricingCatalog().get_pricing(entry.provider, entry.model_id)
    reason = UNPRICED_MODELS.get(entry.provider, {}).get(entry.model_id)
    assert (pricing is None) == (reason is not None), (
        f"{entry.provider}/{entry.model_id}: price {pricing}, reason {reason!r}"
    )


def test_unpriced_lists_name_only_offered_models():
    offered = {(e.provider, e.model_id) for e in REGISTRY}
    stale = [
        (provider, model)
        for provider, models in UNPRICED_MODELS.items()
        for model in models
        if (provider, model) not in offered
    ]
    assert stale == []
    assert set(UNPRICED_PROVIDERS) <= {e.provider for e in REGISTRY}
