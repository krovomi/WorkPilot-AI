"""What the loop's corrections cost, in tokens and in money, and when to stop.

Each correction is one vision call. Its tokens are the ones the provider
reported (``read_usage`` reads the four shapes the service's calls receive:
Anthropic's, OpenAI's, Gemini's and Ollama's); a route that reports none (the
local model through ``docintel``) is counted by ``estimate_usage`` and marked
``estimated``, so the page says "about".

The money is never guessed. The runner hands the loop a ``Pricing`` built from
the price catalogue (``cost_intelligence.catalog``): ``priced`` when the
catalogue has the route's model, ``flat_rate`` when the route is billed by a
plan or runs locally (no per-token price), ``unknown`` otherwise. An unknown
cost is shown as such, and a cost budget it cannot check is said to be
unchecked rather than enforced on an invented figure.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

#: Characters per token in the estimate (English and code, roughly).
_CHARS_PER_TOKEN = 4
#: Pixels per image token in the estimate (the ratio Anthropic publishes).
_PIXELS_PER_TOKEN = 750
PRICED, FLAT_RATE, UNKNOWN = "priced", "flat_rate", "unknown"


@dataclass(frozen=True)
class Usage:
    """The tokens of one model call."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    estimated: bool = False

    @property
    def total(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_write_tokens
            + self.cache_read_tokens
        )


def _count(mapping: object, key: str) -> int:
    value = mapping.get(key) if isinstance(mapping, dict) else None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def read_usage(payload: object) -> Usage | None:
    """The tokens a provider's answer reports, or None when it reports none.

    ``payload`` is the decoded JSON of an answer (or the SDK's usage dict).
    """
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage", payload)
    if isinstance(usage, dict) and (
        "input_tokens" in usage or "output_tokens" in usage
    ):
        return Usage(
            _count(usage, "input_tokens"),
            _count(usage, "output_tokens"),
            _count(usage, "cache_creation_input_tokens"),
            _count(usage, "cache_read_input_tokens"),
        )
    if isinstance(usage, dict) and (
        "prompt_tokens" in usage or "completion_tokens" in usage
    ):
        prompt = _count(usage, "prompt_tokens")
        cached = min(
            prompt, _count(usage.get("prompt_tokens_details"), "cached_tokens")
        )
        return Usage(
            prompt - cached,
            _count(usage, "completion_tokens"),
            cache_read_tokens=cached,
        )
    meta = payload.get("usageMetadata")
    if isinstance(meta, dict):
        prompt = _count(meta, "promptTokenCount")
        cached = min(prompt, _count(meta, "cachedContentTokenCount"))
        return Usage(
            prompt - cached,
            _count(meta, "candidatesTokenCount") + _count(meta, "thoughtsTokenCount"),
            cache_read_tokens=cached,
        )
    if "prompt_eval_count" in payload or "eval_count" in payload:
        return Usage(
            _count(payload, "prompt_eval_count"), _count(payload, "eval_count")
        )
    return None


def estimate_usage(prompt: str, image_size: tuple[int, int], answer: str) -> Usage:
    """An estimate for a call whose provider reported no tokens."""
    width, height = image_size
    image = math.ceil(max(0, width) * max(0, height) / _PIXELS_PER_TOKEN)
    return Usage(
        math.ceil(len(prompt) / _CHARS_PER_TOKEN) + image,
        math.ceil(len(answer) / _CHARS_PER_TOKEN),
        estimated=True,
    )


@dataclass(frozen=True)
class Pricing:
    """How the route's tokens are paid: ``status`` and, unless unknown, ``price``."""

    status: str = UNKNOWN
    price: Callable[[Usage], float] | None = None


@dataclass
class Spend:
    """The running total of the loop's corrections."""

    pricing: Pricing = Pricing()
    input_tokens: int = 0
    output_tokens: int = 0
    estimated: bool = False
    cost_usd: float = 0.0
    last_tokens: int = 0
    last_cost: float = 0.0

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def known_cost(self) -> float | None:
        if self.pricing.status == UNKNOWN or self.pricing.price is None:
            return None
        return self.cost_usd

    def add(self, usage: Usage) -> tuple[int, float | None]:
        """Count one call; (its tokens, its cost or None when unknown)."""
        cost = (
            self.pricing.price(usage)
            if self.pricing.status != UNKNOWN and self.pricing.price
            else None
        )
        self.input_tokens += (
            usage.input_tokens + usage.cache_write_tokens + usage.cache_read_tokens
        )
        self.output_tokens += usage.output_tokens
        self.estimated = self.estimated or usage.estimated
        self.last_tokens = usage.total
        self.last_cost = cost or 0.0
        self.cost_usd += cost or 0.0
        return usage.total, (None if cost is None else round(cost, 6))

    def exhausted(self, max_tokens: int, max_cost_usd: float) -> str | None:
        """``tokens`` or ``cost`` when the next correction, as large as the
        last one, would go past that budget; None while both allow it."""
        if max_tokens > 0 and self.tokens + self.last_tokens > max_tokens:
            return "tokens"
        cost = self.known_cost
        if (
            max_cost_usd > 0
            and cost is not None
            and cost + self.last_cost > max_cost_usd
        ):
            return "cost"
        return None

    def as_dict(self, max_tokens: int, max_cost_usd: float) -> dict:
        cost = self.known_cost
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "tokens": self.tokens,
            "estimated": self.estimated,
            "cost_status": self.pricing.status,
            "cost_usd": None if cost is None else round(cost, 6),
            "max_tokens": max_tokens,
            "max_cost_usd": max_cost_usd,
            # A cost budget is only enforced on a cost the catalogue gives.
            "cost_budget_checked": cost is not None,
        }
