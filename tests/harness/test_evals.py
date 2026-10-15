"""harness.domain.evals: a prompt cache by capability, two measures, the baseline judge."""

from __future__ import annotations

import pytest
from harness.domain.evals import (
    RATIO_TOLERANCE,
    CachedInput,
    CacheModel,
    CacheShape,
    PromptCache,
    SentRequest,
    prefix_breaks,
    regressions,
    shared_block_chars,
    shared_chars,
    tokens,
    tool_result_share,
)

# Blocks of 4,000 characters: 1,000 tokens each.
SYSTEM = "s" * 4_000
TASK = "t" * 4_000
TURN = "u" * 4_000


@pytest.mark.parametrize(("chars", "expected"), [(0, 0), (1, 1), (4, 1), (5, 2)])
def test_tokens_round_up(chars, expected):
    assert tokens(chars) == expected


def test_shared_chars_goes_into_the_first_block_that_differs():
    assert shared_chars(["ab", "cd"], ["ab", "cx"]) == 3
    assert shared_chars(["ab", "cd"], ["ab", "cd", "ef"]) == 4
    assert shared_chars(["xb"], ["ab"]) == 0


def test_shared_block_chars_counts_whole_blocks_only():
    assert shared_block_chars(["ab", "cd"], ["ab", "cx"]) == 2
    assert shared_block_chars(["ab", "cd"], ["ab", "cd", "ef"]) == 4


def test_a_token_prefix_cache_serves_the_longest_shared_prefix_in_steps():
    cache = PromptCache(
        CacheModel(CacheShape.TOKEN_PREFIX, min_tokens=1024, step_tokens=128)
    )
    assert cache.send([SYSTEM, TASK]) == CachedInput(2_000, 0, 2_000)
    # 2,000 tokens shared, served in steps of 128.
    assert cache.send([SYSTEM, TASK, TURN]) == CachedInput(3_000, 1_920, 1_080)
    # An edit inside a block still serves what precedes it in that block.
    edited = TASK[:2_000] + "x" * 2_000
    assert cache.send([SYSTEM, edited]).cache_read == 1_408


def test_a_token_prefix_cache_serves_nothing_under_its_minimum():
    cache = PromptCache(CacheModel(CacheShape.TOKEN_PREFIX, min_tokens=1024))
    cache.send(["s" * 2_000, TASK])
    assert cache.send(["s" * 2_000, "y"]).cache_read == 0


def test_a_token_prefix_cache_serves_an_older_request_too():
    cache = PromptCache(CacheModel(CacheShape.TOKEN_PREFIX, min_tokens=1024))
    cache.send([SYSTEM, TASK, TURN])
    cache.send([SYSTEM, "o" * 4_000])
    # The second subtask shares the task block with the first, not the last.
    assert cache.send([SYSTEM, TASK, "v" * 4_000]).cache_read == 2_000


def test_a_block_cache_serves_whole_blocks_and_writes_the_rest():
    cache = PromptCache(CacheModel(CacheShape.BLOCKS, min_tokens=512))
    assert cache.send([SYSTEM, TASK]) == CachedInput(2_000, 0, 2_000)
    assert cache.send([SYSTEM, TASK, TURN]) == CachedInput(3_000, 2_000, 1_000)
    # Half a block shared is no block shared.
    edited = TASK[:2_000] + "x" * 2_000
    assert cache.send([SYSTEM, edited]) == CachedInput(2_000, 1_000, 1_000)


def test_a_block_cache_stores_nothing_under_its_minimum():
    cache = PromptCache(CacheModel(CacheShape.BLOCKS, min_tokens=1024))
    assert cache.send(["s" * 400]) == CachedInput(100, 0, 0)
    assert cache.send(["s" * 400, "t" * 400]) == CachedInput(200, 0, 0)


def test_a_cache_that_reports_nothing_says_nothing():
    cache = PromptCache(CacheModel(CacheShape.NONE))
    cache.send([SYSTEM])
    assert cache.send([SYSTEM, TASK]) == CachedInput(2_000, None, None)


def _request(*blocks: str, session: int = 1, cleared: bool = False) -> SentRequest:
    return SentRequest(
        tuple(blocks), tool_chars=0, session=session, after_clearing=cleared
    )


@pytest.mark.parametrize(
    ("requests", "expected"),
    [
        ([_request("a"), _request("a", "b"), _request("a", "b", "c")], 0),
        # An earlier message was rewritten.
        ([_request("a", "b"), _request("a", "B", "c")], 1),
        # A clearing rewrites on purpose; it is counted apart.
        ([_request("a", "b"), _request("a", "[cleared]", "c", cleared=True)], 0),
        # A new subtask starts a new session.
        ([_request("a", "b"), _request("a", "c", session=2)], 0),
    ],
)
def test_prefix_breaks(requests, expected):
    assert prefix_breaks(requests) == expected


def test_tool_result_share():
    requests = [
        SentRequest(("aaaa", "bbbb"), tool_chars=4, session=1),
        SentRequest(("aaaa", "bbbb", "cc"), tool_chars=6, session=1),
    ]
    assert tool_result_share(requests) == pytest.approx(10 / 18)
    assert tool_result_share([]) is None


BASELINE = {
    "calls": 10,
    "prefix_breaks": 0,
    "task_prefix_share": 1.0,
    "tool_result_share": 0.5,
    "spilled_outputs": 1,
    "clearings": 1,
    "payable_window_tokens": 200_000,
    "peak_window_share": 0.4,
    "nudged_at_turn": None,
    "stopped_at_turn": None,
    "profiles": {
        "token_prefix": {
            "cache_hit_ratio": 0.8,
            "prefix_rewrites": 1,
            "prefix_rewrites_outside_clearing": 0,
        },
        "unreported": {
            "cache_hit_ratio": None,
            "prefix_rewrites": 0,
            "prefix_rewrites_outside_clearing": 0,
        },
    },
}


def _with(profile: str | None = None, **changes) -> dict:
    current = {
        **BASELINE,
        "profiles": {k: dict(v) for k, v in BASELINE["profiles"].items()},
    }
    (current["profiles"][profile] if profile else current).update(changes)
    return current


def test_the_same_numbers_are_no_regression():
    assert regressions(_with(), BASELINE) == []


@pytest.mark.parametrize(
    ("current", "measure"),
    [
        (
            _with("token_prefix", cache_hit_ratio=0.8 - 2 * RATIO_TOLERANCE),
            "cache_hit_ratio",
        ),
        (_with("token_prefix", prefix_rewrites=2), "prefix_rewrites"),
        (_with(tool_result_share=0.5 + 2 * RATIO_TOLERANCE), "tool_result_share"),
        (_with(task_prefix_share=0.9), "task_prefix_share"),
        # Counts have no margin.
        (_with(prefix_breaks=1), "prefix_breaks"),
        # A behaviour, either way: clearing twice, or never.
        (_with(clearings=2), "clearings"),
        (_with(clearings=0), "clearings"),
        (_with(stopped_at_turn=5), "stopped_at_turn"),
        (_with(payable_window_tokens=1_000_000), "payable_window_tokens"),
        # Unknown stays unknown: a hit ratio of 0 is not "not reported".
        (_with("unreported", cache_hit_ratio=0.0), "cache_hit_ratio"),
        (_with("token_prefix", cache_hit_ratio=None), "cache_hit_ratio"),
    ],
)
def test_a_worse_number_is_a_regression(current, measure):
    [found] = regressions(current, BASELINE)
    assert found.startswith(measure)


@pytest.mark.parametrize(
    "current",
    [
        _with("token_prefix", cache_hit_ratio=0.95),
        _with("token_prefix", cache_hit_ratio=0.8 - RATIO_TOLERANCE / 2),
        _with("token_prefix", prefix_rewrites=0),
        _with(tool_result_share=0.3, peak_window_share=0.2),
    ],
)
def test_a_better_number_or_one_within_the_margin_passes(current):
    assert regressions(current, BASELINE) == []


def test_a_measure_or_a_shape_on_one_side_only_is_reported():
    missing = _with()
    del missing["clearings"]
    assert regressions(missing, BASELINE) == ["clearings: no longer measured"]
    assert regressions(_with(), {**BASELINE, "cost_usd": 1.0}) == [
        "cost_usd: in the baseline, not a known measure"
    ]
    extra = _with()
    extra["profiles"]["blocks"] = dict(extra["profiles"]["token_prefix"])
    assert regressions(extra, BASELINE) == ["profile 'blocks': not in the baseline"]
