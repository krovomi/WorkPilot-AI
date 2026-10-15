"""harness.domain.ledger: totals, cache hit ratio and prefix rewrites of a session."""

from __future__ import annotations

import json

import pytest
from harness.domain.ledger import MIN_CACHEABLE_PROMPT, UsageLedger
from harness.domain.usage import CallUsage


def _ledger(*calls: CallUsage) -> UsageLedger:
    ledger = UsageLedger()
    for call in calls:
        ledger.record(call)
    return ledger


def test_healthy_append_only_session_has_no_rewrite():
    # Each call reads back the whole previous prompt and writes what was added.
    ledger = _ledger(
        CallUsage(10_000, 0, 10_000, 200),
        CallUsage(12_000, 10_000, 2_000, 200),
        CallUsage(15_000, 12_000, 3_000, 200),
    )
    assert ledger.prefix_rewrites == 0
    assert ledger.cache_hit_ratio() == pytest.approx(22_000 / 37_000)


def test_a_call_that_rereads_less_than_half_is_a_rewrite():
    ledger = _ledger(
        CallUsage(10_000, 0, 10_000, 200),
        # The system prompt changed: almost nothing came back from the cache.
        CallUsage(11_000, 500, 10_500, 200),
    )
    assert ledger.prefix_rewrites == 1


def test_a_boundary_makes_the_next_cold_call_expected():
    ledger = _ledger(CallUsage(10_000, 0, 10_000, 200))
    ledger.boundary()
    ledger.record(CallUsage(3_000, 0, 3_000, 100))
    assert ledger.prefix_rewrites == 0


def test_threads_are_compared_with_themselves_only():
    ledger = UsageLedger()
    ledger.record(CallUsage(20_000, 0, 20_000, 100))
    # A sub-agent starts cold on its own prefix: not a rewrite of the main thread.
    ledger.record(CallUsage(4_000, 0, 4_000, 100), thread="subagent-1")
    ledger.record(CallUsage(22_000, 20_000, 2_000, 100))
    assert ledger.prefix_rewrites == 0


def test_short_prompts_and_unreported_caches_are_not_rewrites():
    ledger = _ledger(
        CallUsage(MIN_CACHEABLE_PROMPT - 1, 0, None, 10),
        CallUsage(MIN_CACHEABLE_PROMPT + 10, 0, None, 10),
        # No cache field: nothing to compare.
        CallUsage(5_000, None, None, 10),
        CallUsage(6_000, None, None, 10),
    )
    assert ledger.prefix_rewrites == 0


def test_hit_ratio_is_unknown_when_no_call_reports_a_cache():
    ledger = _ledger(CallUsage(1_200, None, None, 40), CallUsage(1_500, None, None, 40))
    assert ledger.cache_hit_ratio() is None
    assert ledger.summary()["cacheHitRatio"] is None
    assert ledger.cache_read is None


def test_hit_ratio_ignores_calls_without_a_cache_field():
    ledger = _ledger(
        CallUsage(2_000, 1_000, None, 10), CallUsage(50_000, None, None, 10)
    )
    assert ledger.cache_hit_ratio() == pytest.approx(0.5)


def test_tracker_fields_use_the_uncached_part_for_every_format():
    # OpenCode-like (split) and Codex-like (total + cached) calls add up the same way.
    ledger = _ledger(
        CallUsage(prompt=4_200, cache_read=4_000, cache_write=80, output=30),
        CallUsage(prompt=10, cache_read=2, cache_write=None, output=3),
    )
    assert ledger.tracker_fields() == {
        "input_tokens": 120 + 8,
        "output_tokens": 33,
        "cache_creation_input_tokens": 80,
        "cache_read_input_tokens": 4_002,
    }


def test_tracker_fields_of_an_empty_ledger_are_zero():
    assert UsageLedger().tracker_fields() == {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }


def test_nothing_reported_is_ignored():
    ledger = UsageLedger()
    ledger.record(None)
    assert ledger.calls == []


def test_summary_holds_numbers_only():
    ledger = _ledger(CallUsage(10_000, 9_000, 100, 20, reasoning=5))
    summary = ledger.summary()
    assert all(
        value is None or isinstance(value, (int, float)) for value in summary.values()
    )
    json.dumps(summary)
