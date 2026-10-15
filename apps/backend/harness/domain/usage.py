"""One model call, measured the same way whatever the provider.

Every provider reports what a call consumed, each in its own shape, and the
shapes disagree on what a number means: ``input_tokens`` is the uncached part
in an Anthropic usage block and the whole prompt, cache included, in a Codex
turn. This module reads each *wire format* once into five numbers, and the rest
of the harness only ever sees those.

A number the provider does not report is ``None`` ("unknown"), never 0: a
provider that says nothing about its cache has no hit rate, it does not have a
hit rate of zero.

Readers are named after the format, not the provider; their docstrings say who
emits it. Pure functions, table-tested in ``tests/harness/test_usage.py``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CallUsage:
    """What one call put through the model."""

    # Every input token the call sent, cache included: what the window held.
    prompt: int | None
    # Input tokens served from the provider's prompt cache.
    cache_read: int | None
    # Input tokens this call wrote to the cache. Only providers that bill
    # writes report it; elsewhere it is unknown.
    cache_write: int | None
    output: int | None
    # Reasoning tokens, when the provider counts them apart from the output.
    reasoning: int | None = None

    @property
    def uncached(self) -> int | None:
        """Input billed at the full rate: the prompt less what the cache served or stored."""
        if self.prompt is None:
            return None
        return max(0, self.prompt - (self.cache_read or 0) - (self.cache_write or 0))

    @property
    def reports_cache(self) -> bool:
        """Whether the provider said how much of the prompt the cache served."""
        return self.cache_read is not None and self.prompt is not None


def _count(value: object) -> int | None:
    """A token count, or None when the field is absent or not a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, int(value))


def _nested(usage: Mapping[str, Any], outer: str, inner: str) -> int | None:
    block = usage.get(outer)
    return _count(block.get(inner)) if isinstance(block, Mapping) else None


def _sum_known(*values: int | None) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def from_split_cache(usage: Mapping[str, Any] | None) -> CallUsage | None:
    """Uncached input, cache reads and cache writes as three separate fields.

    Emitted by the Anthropic Messages API, hence by the Claude Agent SDK
    (``AssistantMessage.usage``): ``input_tokens`` is the uncached part.
    """
    if not isinstance(usage, Mapping):
        return None
    uncached = _count(usage.get("input_tokens"))
    read = _count(usage.get("cache_read_input_tokens"))
    write = _count(usage.get("cache_creation_input_tokens"))
    prompt = _sum_known(uncached, read, write)
    output = _count(usage.get("output_tokens"))
    if prompt is None and output is None:
        return None
    return CallUsage(prompt=prompt, cache_read=read, cache_write=write, output=output)


def from_chat_completion(usage: Mapping[str, Any] | None) -> CallUsage | None:
    """The ``usage`` block of an OpenAI-style chat completion.

    Emitted by OpenAI and every OpenAI-compatible endpoint WorkPilot drives
    (Google, Mistral, DeepSeek, xAI, Copilot, Windsurf REST). ``prompt_tokens``
    is the whole prompt. The cached part comes, when reported, either as
    ``prompt_tokens_details.cached_tokens`` or as the hit/miss pair
    ``prompt_cache_hit_tokens`` / ``prompt_cache_miss_tokens``.
    """
    if not isinstance(usage, Mapping):
        return None
    total = _count(usage.get("prompt_tokens"))
    hit = _count(usage.get("prompt_cache_hit_tokens"))
    miss = _count(usage.get("prompt_cache_miss_tokens"))
    if hit is not None or miss is not None:
        read = hit or 0
        prompt = total if total is not None else read + (miss or 0)
    else:
        read = _nested(usage, "prompt_tokens_details", "cached_tokens")
        prompt = total
    output = _count(usage.get("completion_tokens"))
    if prompt is None and output is None:
        return None
    return CallUsage(
        prompt=prompt,
        cache_read=read,
        cache_write=None,
        output=output,
        reasoning=_nested(usage, "completion_tokens_details", "reasoning_tokens"),
    )


def from_flat_cached_input(usage: Mapping[str, Any] | None) -> CallUsage | None:
    """A flat turn total whose ``input_tokens`` includes ``cached_input_tokens``.

    Emitted by the Codex CLI on ``turn.completed``.
    """
    if not isinstance(usage, Mapping):
        return None
    prompt = _count(usage.get("input_tokens"))
    output = _count(usage.get("output_tokens"))
    if prompt is None and output is None:
        return None
    return CallUsage(
        prompt=prompt,
        cache_read=_count(usage.get("cached_input_tokens")),
        cache_write=None,
        output=output,
        reasoning=_count(usage.get("reasoning_output_tokens")),
    )


def from_step_tokens(tokens: Mapping[str, Any] | None) -> CallUsage | None:
    """``input`` (uncached), ``cache.read``, ``cache.write``, ``output``, ``reasoning``.

    Emitted by OpenCode on ``step_finish``.
    """
    if not isinstance(tokens, Mapping):
        return None
    cache = tokens.get("cache")
    cache = cache if isinstance(cache, Mapping) else {}
    uncached = _count(tokens.get("input"))
    read = _count(cache.get("read"))
    write = _count(cache.get("write"))
    prompt = _sum_known(uncached, read, write)
    output = _count(tokens.get("output"))
    if prompt is None and output is None:
        return None
    return CallUsage(
        prompt=prompt,
        cache_read=read,
        cache_write=write,
        output=output,
        reasoning=_count(tokens.get("reasoning")),
    )


def from_ambiguous_cache_read(usage: Mapping[str, Any] | None) -> CallUsage | None:
    """``input_tokens`` and ``cache_read_tokens``, inclusion not documented.

    Emitted by the Antigravity CLI. ``total_tokens`` settles it when present: a
    total that covers input, output, thinking *and* the cache reads means they
    are separate. With no total the cache reads are added — over-counting
    compacts a little early, under-counting overflows.
    """
    if not isinstance(usage, Mapping):
        return None
    fresh = _count(usage.get("input_tokens")) or 0
    cached = _count(usage.get("cache_read_tokens"))
    output = _count(usage.get("output_tokens"))
    thinking = _count(usage.get("thinking_tokens"))
    if not fresh and not cached:
        if output is None:
            return None
        return CallUsage(None, cached, None, output, thinking)
    prompt = fresh + (cached or 0)
    total = _count(usage.get("total_tokens"))
    if total is not None and cached:
        visible = fresh + (output or 0) + (thinking or 0)
        if total < visible + cached:
            # The total leaves no room for the cache reads: they were inside
            # input_tokens already.
            prompt = fresh
    return CallUsage(prompt, cached, None, output, thinking)


def from_eval_counts(data: Mapping[str, Any] | None) -> CallUsage | None:
    """``prompt_eval_count`` and ``eval_count``, nothing about a cache.

    Emitted by Ollama (and read the same way for LM Studio's native API).
    """
    if not isinstance(data, Mapping):
        return None
    prompt = _count(data.get("prompt_eval_count"))
    output = _count(data.get("eval_count"))
    if prompt is None and output is None:
        return None
    return CallUsage(prompt=prompt, cache_read=None, cache_write=None, output=output)
