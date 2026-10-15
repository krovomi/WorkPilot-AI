"""harness.domain.usage: every wire format read into the same five numbers.

One table per format. The rows that matter most are the ones with a field
missing: a provider that does not report its cache must come out as "unknown"
(None), never as a cache of zero.
"""

from __future__ import annotations

import pytest
from harness.domain.usage import (
    CallUsage,
    from_ambiguous_cache_read,
    from_chat_completion,
    from_eval_counts,
    from_flat_cached_input,
    from_split_cache,
    from_step_tokens,
)


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        # Anthropic: input_tokens is the uncached part.
        (
            {
                "input_tokens": 100,
                "cache_read_input_tokens": 9000,
                "cache_creation_input_tokens": 400,
                "output_tokens": 50,
            },
            CallUsage(prompt=9500, cache_read=9000, cache_write=400, output=50),
        ),
        # No cache fields at all: the cache is unknown, not empty.
        (
            {"input_tokens": 100, "output_tokens": 5},
            CallUsage(prompt=100, cache_read=None, cache_write=None, output=5),
        ),
        (None, None),
        ({}, None),
        ({"input_tokens": "a lot", "output_tokens": True}, None),
    ],
)
def test_split_cache(usage, expected):
    assert from_split_cache(usage) == expected


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        # OpenAI: prompt_tokens is the whole prompt, the cached part is inside it.
        (
            {
                "prompt_tokens": 2000,
                "completion_tokens": 30,
                "prompt_tokens_details": {"cached_tokens": 1536},
                "completion_tokens_details": {"reasoning_tokens": 12},
            },
            CallUsage(
                prompt=2000, cache_read=1536, cache_write=None, output=30, reasoning=12
            ),
        ),
        # The hit/miss pair (DeepSeek) wins over the details block.
        (
            {
                "prompt_tokens": 2000,
                "completion_tokens": 30,
                "prompt_cache_hit_tokens": 1800,
                "prompt_cache_miss_tokens": 200,
            },
            CallUsage(prompt=2000, cache_read=1800, cache_write=None, output=30),
        ),
        # Hit/miss without a total: the two add up to the prompt.
        (
            {"prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 700},
            CallUsage(prompt=700, cache_read=0, cache_write=None, output=None),
        ),
        # Copilot, Windsurf, Mistral without details: cache unknown.
        (
            {"prompt_tokens": 1200, "completion_tokens": 40},
            CallUsage(prompt=1200, cache_read=None, cache_write=None, output=40),
        ),
        (None, None),
        ({}, None),
    ],
)
def test_chat_completion(usage, expected):
    assert from_chat_completion(usage) == expected


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        # Codex: input_tokens already includes cached_input_tokens.
        (
            {
                "input_tokens": 10,
                "cached_input_tokens": 2,
                "output_tokens": 3,
                "reasoning_output_tokens": 1,
            },
            CallUsage(prompt=10, cache_read=2, cache_write=None, output=3, reasoning=1),
        ),
        (
            {"input_tokens": 10, "output_tokens": 3},
            CallUsage(prompt=10, cache_read=None, cache_write=None, output=3),
        ),
        ({}, None),
    ],
)
def test_flat_cached_input(usage, expected):
    assert from_flat_cached_input(usage) == expected


@pytest.mark.parametrize(
    ("tokens", "expected"),
    [
        # OpenCode: input is the uncached part, the cache is beside it.
        (
            {
                "input": 120,
                "output": 30,
                "reasoning": 4,
                "cache": {"read": 4000, "write": 80},
            },
            CallUsage(
                prompt=4200, cache_read=4000, cache_write=80, output=30, reasoning=4
            ),
        ),
        (
            {"input": 120, "output": 30},
            CallUsage(prompt=120, cache_read=None, cache_write=None, output=30),
        ),
        ({"cache": "not a dict"}, None),
    ],
)
def test_step_tokens(tokens, expected):
    assert from_step_tokens(tokens) == expected


@pytest.mark.parametrize(
    ("usage", "prompt", "cache_read"),
    [
        # A total that leaves room for the cache reads: they are separate.
        (
            {
                "input_tokens": 100,
                "cache_read_tokens": 900,
                "output_tokens": 10,
                "thinking_tokens": 5,
                "total_tokens": 1015,
            },
            1000,
            900,
        ),
        # A total that does not: the reads were inside input_tokens.
        (
            {
                "input_tokens": 1000,
                "cache_read_tokens": 900,
                "output_tokens": 10,
                "total_tokens": 1010,
            },
            1000,
            900,
        ),
        # No total: added, over-counting rather than overflowing.
        ({"input_tokens": 100, "cache_read_tokens": 900}, 1000, 900),
        ({"input_tokens": 100}, 100, None),
        ({"output_tokens": 7}, None, None),
    ],
)
def test_ambiguous_cache_read(usage, prompt, cache_read):
    usage = from_ambiguous_cache_read(usage)
    assert usage is not None
    assert (usage.prompt, usage.cache_read) == (prompt, cache_read)


def test_ambiguous_cache_read_with_nothing_reported():
    assert from_ambiguous_cache_read({}) is None
    assert from_ambiguous_cache_read(None) is None


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (
            {"prompt_eval_count": 3000, "eval_count": 200},
            CallUsage(prompt=3000, cache_read=None, cache_write=None, output=200),
        ),
        ({"done": True}, None),
    ],
)
def test_eval_counts(data, expected):
    assert from_eval_counts(data) == expected


@pytest.mark.parametrize(
    ("usage", "uncached", "reports_cache"),
    [
        (CallUsage(9500, 9000, 400, 50), 100, True),
        # No cache reported: the whole prompt is billed at the full rate.
        (CallUsage(1200, None, None, 40), 1200, False),
        (CallUsage(None, 10, None, 40), None, False),
        # A provider that reads but never reports writes.
        (CallUsage(2000, 1536, None, 30), 464, True),
    ],
)
def test_derived_fields(usage, uncached, reports_cache):
    assert usage.uncached == uncached
    assert usage.reports_cache is reports_cache
