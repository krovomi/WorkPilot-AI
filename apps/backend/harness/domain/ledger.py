"""The calls of one session, and what they say about the cache.

Built from :class:`~harness.domain.usage.CallUsage` only, so it reads the same
for a loop WorkPilot runs and for one a third-party SDK or CLI runs: neither
the request nor the provider's name is needed.

Two signals come out of it besides the totals:

* the **cache hit ratio** — tokens read from the cache over the prompt tokens of
  the calls that report a cache. ``None`` when no call does: unknown, not zero.
* **prefix rewrites** — calls that reused less than half of what the previous
  call of the same thread sent. In an append-only session each call should
  find the whole previous prompt in the cache; when it does not, the prefix
  changed (an edited system prompt, a reordered tool list) or the cache
  expired. Either way, the call paid for what it should have read.

Pure, table-tested in ``tests/harness/test_ledger.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .usage import CallUsage

# Below this many prompt tokens no provider caches (Anthropic's smallest
# minimum is 512, OpenAI's is 1024): a cold call after such a short one says
# nothing about the prefix.
MIN_CACHEABLE_PROMPT = 1024

# A call that reads back less than this share of the previous prompt counts as
# a rewrite.
REWRITE_SHARE = 0.5


@dataclass
class UsageLedger:
    """Every call of one session, grouped by thread.

    A thread is one conversation sharing a prefix: the main loop (``None``),
    or a sub-agent identified by whatever the provider uses to tell them apart.
    """

    calls: list[CallUsage] = field(default_factory=list)
    prefix_rewrites: int = 0
    _last_prompt: dict[str | None, int] = field(
        default_factory=dict, init=False, repr=False
    )

    def record(self, usage: CallUsage | None, *, thread: str | None = None) -> None:
        """Add one call. ``None`` (nothing reported) is ignored."""
        if usage is None:
            return
        previous = self._last_prompt.get(thread)
        if (
            previous is not None
            and previous >= MIN_CACHEABLE_PROMPT
            and usage.cache_read is not None
            and usage.cache_read < previous * REWRITE_SHARE
        ):
            self.prefix_rewrites += 1
        if usage.prompt is not None:
            self._last_prompt[thread] = usage.prompt
        self.calls.append(usage)

    def boundary(self, *, thread: str | None = None) -> None:
        """The thread starts over (compaction, fresh thread): the next cold call is expected."""
        self._last_prompt.pop(thread, None)

    def _sum(self, attribute: str) -> int | None:
        values = [getattr(call, attribute) for call in self.calls]
        known = [value for value in values if value is not None]
        return sum(known) if known else None

    @property
    def prompt(self) -> int | None:
        return self._sum("prompt")

    @property
    def cache_read(self) -> int | None:
        return self._sum("cache_read")

    @property
    def cache_write(self) -> int | None:
        return self._sum("cache_write")

    @property
    def output(self) -> int | None:
        return self._sum("output")

    @property
    def reasoning(self) -> int | None:
        return self._sum("reasoning")

    @property
    def uncached(self) -> int | None:
        return self._sum("uncached")

    def cache_hit_ratio(self) -> float | None:
        """Read from the cache ÷ prompt, over the calls that report a cache."""
        reporting = [call for call in self.calls if call.reports_cache]
        prompt = sum(call.prompt or 0 for call in reporting)
        if not prompt:
            return None
        return sum(call.cache_read or 0 for call in reporting) / prompt

    def tracker_fields(self) -> dict[str, int]:
        """Totals in the shape ``core.usage_tracker.record_session_usage`` takes.

        ``input_tokens`` is the uncached part there, whatever the provider: the
        cache has its own two fields, and the carbon ledger adds all three.
        """
        return {
            "input_tokens": self.uncached or 0,
            "output_tokens": self.output or 0,
            "cache_creation_input_tokens": self.cache_write or 0,
            "cache_read_input_tokens": self.cache_read or 0,
        }

    def summary(self) -> dict[str, float | int | None]:
        """Numbers only, never a message body: safe for events and logs."""
        ratio = self.cache_hit_ratio()
        return {
            "calls": len(self.calls),
            "promptTokens": self.prompt,
            "cacheReadTokens": self.cache_read,
            "cacheWriteTokens": self.cache_write,
            "outputTokens": self.output,
            "cacheHitRatio": None if ratio is None else round(ratio, 4),
            "prefixRewrites": self.prefix_rewrites,
        }
