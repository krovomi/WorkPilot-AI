"""What a replayed session says about the context, and whether it got worse.

Lot 8 replays recorded sessions through the production code
(``harness.application.replay``) on every PR, without a model. What comes out
is a list of requests; this module judges them, the same way for every
provider.

* **The prompt cache, by capability.** No provider is called, so none reports
  what its cache served: ``PromptCache`` says it, from the requests themselves,
  for each shape a cache can have. A token-prefix cache (OpenAI and its
  compatibles, DeepSeek, Gemini) serves the longest prefix a request shares
  with an earlier one, from a minimum and in steps. A block cache (Anthropic)
  serves whole blocks up to a breakpoint: a partial match inside a block
  serves nothing. A provider that reports no cache has none to say: unknown,
  never 0. The numbers go through the production usage readers and ledger, so
  the hit ratio and the prefix rewrites are the ones the gauge would show.
* **Two measures of the requests**: the breaks of the append-only rule, and
  the share of tool results in what was sent.
* **The baseline.** Each scenario keeps the numbers it produced when they were
  last accepted. ``regressions`` names every number that got worse; a better
  one passes, and is locked in by refreshing the baseline. A campaign with a
  real model would write the same numbers, and the same function reads them.

Tokens are estimated at four characters each, the estimate ``context_mgmt``
uses where no tokenizer is at hand: the replay compares requests with each
other, and the ratio holds whatever the tokenizer.

Pure, table-tested in ``tests/harness/test_evals.py``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

CHARS_PER_TOKEN = 4

# Room a ratio may lose before it counts as worse: a reworded prompt moves the
# hit ratio or the composition by a fraction of a point, a cache break by tens.
# Counts (rewrites, clearings, breaks) have no margin.
RATIO_TOLERANCE = 0.01


def tokens(chars: int) -> int:
    """The tokens ``chars`` characters make, rounded up."""
    return -(-max(0, chars) // CHARS_PER_TOKEN)


class CacheShape(StrEnum):
    """How a provider's prompt cache matches a request."""

    TOKEN_PREFIX = "token_prefix"  # the longest common prefix, in tokens
    BLOCKS = "blocks"  # whole blocks, up to a breakpoint
    NONE = "none"  # nothing reported


@dataclass(frozen=True)
class CacheModel:
    """A provider's prompt cache, described by what it can do.

    ``min_tokens``: below it nothing is cached. ``step_tokens``: a
    token-prefix cache serves its match in steps of this size.
    """

    shape: CacheShape
    min_tokens: int = 1024
    step_tokens: int = 1


@dataclass(frozen=True)
class CachedInput:
    """The input side of one call: what the cache served and stored.

    ``cache_read`` and ``cache_write`` are None when the shape reports nothing.
    """

    prompt: int
    cache_read: int | None
    cache_write: int | None


def _common_start(first: str, second: str) -> int:
    """Characters two strings share from their start (slices compare in C)."""
    low, high = 0, min(len(first), len(second))
    while low < high:
        middle = (low + high + 1) // 2
        if first[:middle] == second[:middle]:
            low = middle
        else:
            high = middle - 1
    return low


def shared_chars(first: Sequence[str], second: Sequence[str]) -> int:
    """Characters two requests share from their start, into the first block that differs."""
    total = 0
    for block, other in zip(first, second):
        if block is other or block == other:
            total += len(block)
            continue
        return total + _common_start(block, other)
    return total


def shared_block_chars(first: Sequence[str], second: Sequence[str]) -> int:
    """Characters of the leading blocks two requests share whole."""
    total = 0
    for block, other in zip(first, second):
        if block is not other and block != other:
            break
        total += len(block)
    return total


@dataclass
class PromptCache:
    """What one cache serves a session's requests, in the order they are sent.

    Every request is kept: a later one may share more with an older request
    than with the previous one (a new subtask shares the task block with the
    first request of the last one). A cache entry does not expire here: the
    replay has no clock, so the lifetime of a cache is left to D3.
    """

    model: CacheModel
    _sent: list[tuple[str, ...]] = field(default_factory=list, init=False, repr=False)

    def send(self, blocks: Sequence[str]) -> CachedInput:
        """The input of the call that sends ``blocks``, then remember it."""
        request = tuple(blocks)
        prompt = tokens(sum(len(block) for block in request))
        cached = self._serve(request, prompt)
        self._sent.append(request)
        return cached

    def _serve(self, request: tuple[str, ...], prompt: int) -> CachedInput:
        model = self.model
        if model.shape is CacheShape.NONE:
            return CachedInput(prompt, None, None)
        if model.shape is CacheShape.TOKEN_PREFIX:
            best = max((shared_chars(request, sent) for sent in self._sent), default=0)
            read = best // CHARS_PER_TOKEN
            read = read - read % max(1, model.step_tokens)
            read = min(prompt, read) if read >= model.min_tokens else 0
            return CachedInput(prompt, read, prompt - read)
        if prompt < model.min_tokens:
            # Too short to be cached at all: billed in full, nothing stored.
            return CachedInput(prompt, 0, 0)
        best = max(
            (shared_block_chars(request, sent) for sent in self._sent), default=0
        )
        read = min(prompt, best // CHARS_PER_TOKEN)
        read = read if read >= model.min_tokens else 0
        # The breakpoint sits on the last block: what was not read is written.
        return CachedInput(prompt, read, prompt - read)


@dataclass(frozen=True)
class SentRequest:
    """One request of a replayed session, as the measures need it.

    ``blocks``: the request in the order it is sent (tool definitions, system,
    then each message). ``tool_chars``: how many of its characters are tool
    results. ``after_clearing``: old tool results were cleared just before it,
    so it was expected to break the prefix.
    """

    blocks: tuple[str, ...]
    tool_chars: int
    session: int
    after_clearing: bool = False

    @property
    def chars(self) -> int:
        return sum(len(block) for block in self.blocks)


def prefix_breaks(requests: Sequence[SentRequest]) -> int:
    """Requests that do not extend the one before them in their session.

    In an append-only session each request starts with the whole previous one.
    A clearing breaks that on purpose and is counted apart; anything else
    rewrote what the provider had cached.
    """
    breaks = 0
    for before, after in zip(requests, requests[1:]):
        if after.session != before.session or after.after_clearing:
            continue
        if shared_block_chars(before.blocks, after.blocks) < before.chars:
            breaks += 1
    return breaks


def tool_result_share(requests: Sequence[SentRequest]) -> float | None:
    """Tool results ÷ everything sent, over every request of the session."""
    total = sum(request.chars for request in requests)
    if not total:
        return None
    return sum(request.tool_chars for request in requests) / total


class Better(StrEnum):
    """Which way a number may move without being a regression."""

    LOWER = "lower"
    HIGHER = "higher"
    SAME = "same"


# The numbers of a scenario, and which way is better. ``SAME``: the number
# describes what the session did (when it stopped, how often it cleared); a
# change there is a change of behaviour, accepted only by refreshing.
SESSION_METRICS: Mapping[str, Better] = {
    "calls": Better.SAME,
    "prefix_breaks": Better.LOWER,
    "task_prefix_share": Better.HIGHER,
    "tool_result_share": Better.LOWER,
    "spilled_outputs": Better.SAME,
    "clearings": Better.SAME,
    "payable_window_tokens": Better.SAME,
    "peak_window_share": Better.LOWER,
    "nudged_at_turn": Better.SAME,
    "stopped_at_turn": Better.SAME,
}

# The numbers of one cache shape, read from the ledger.
PROFILE_METRICS: Mapping[str, Better] = {
    "cache_hit_ratio": Better.HIGHER,
    "prefix_rewrites": Better.LOWER,
    "prefix_rewrites_outside_clearing": Better.LOWER,
}


def _worse(better: Better, current: Any, baseline: Any, tolerance: float) -> bool:
    if current is None or baseline is None:
        # Unknown stays unknown: a hit ratio of 0 where none was reported is
        # a change, not a measure.
        return current != baseline
    if better is Better.SAME:
        return current != baseline
    margin = (
        tolerance if isinstance(current, float) or isinstance(baseline, float) else 0
    )
    if better is Better.LOWER:
        return current > baseline + margin
    return current < baseline - margin


def _compare(
    current: Mapping[str, Any],
    baseline: Mapping[str, Any],
    metrics: Mapping[str, Better],
    where: str,
    tolerance: float,
) -> list[str]:
    found: list[str] = []
    for name in sorted(metrics):
        if name not in baseline:
            found.append(f"{name}{where}: not in the baseline")
        elif name not in current:
            found.append(f"{name}{where}: no longer measured")
        elif _worse(metrics[name], current[name], baseline[name], tolerance):
            better = metrics[name]
            found.append(
                f"{name}{where}: {current[name]!r}, baseline {baseline[name]!r}"
                + (" (changed)" if better is Better.SAME else f" ({better} is better)")
            )
    for name in sorted(set(baseline) - set(metrics) - {"profiles"}):
        found.append(f"{name}{where}: in the baseline, not a known measure")
    return found


def regressions(
    current: Mapping[str, Any],
    baseline: Mapping[str, Any],
    *,
    tolerance: float = RATIO_TOLERANCE,
) -> list[str]:
    """Every number of ``current`` worse than in ``baseline``, one line each.

    Both are a scenario's numbers: ``SESSION_METRICS`` at the top, and
    ``PROFILE_METRICS`` under ``profiles``, one entry per cache shape. A
    measure or a shape present on one side only is reported too: the
    baseline is refreshed, never read loosely.
    """
    found = _compare(current, baseline, SESSION_METRICS, "", tolerance)
    profiles = current.get("profiles") or {}
    expected = baseline.get("profiles") or {}
    for name in sorted(set(profiles) | set(expected)):
        if name not in expected:
            found.append(f"profile {name!r}: not in the baseline")
        elif name not in profiles:
            found.append(f"profile {name!r}: in the baseline, not replayed")
        else:
            found += _compare(
                profiles[name], expected[name], PROFILE_METRICS, f" [{name}]", tolerance
            )
    return found
