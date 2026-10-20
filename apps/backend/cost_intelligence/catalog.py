"""
Pricing Catalog — Versioned per-model pricing for all supported providers.

Prices are expressed in USD per 1M tokens. The catalog covers input,
output, cache_write, cache_read, thinking, and vision token types.

Ollama models default to $0 but can optionally track energy cost.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# What may follow a catalog key in a model id that still names the keyed model:
# a snapshot or release tag. A date or build number (-20251101, -2025-08-07,
# -0709, -001), -latest, -preview, -exp, -beta, xAI's -reasoning and
# -non-reasoning, a Bedrock version (-v1:0), a Vertex version (@20251101), a
# local tag (:70b), Claude's [1m]. Anything else is another model at another
# price: gpt-5 → gpt-5.5, claude-opus-5 → claude-opus-5-5, gpt-5.5 →
# gpt-5.5-mini, grok-4 → grok-4-1-fast.
_TAG = r"latest|preview|exp|experimental|beta|reasoning|non-reasoning|v\d+(?::\d+)?"
_SNAPSHOT_SUFFIX = re.compile(
    rf"(?:-(?:\d{{3,}}|{_TAG})(?:-(?:\d+|{_TAG}))*)?(?:[@:].*|\[1m\])?"
)


@dataclass(frozen=True)
class ModelPricing:
    """Per-model pricing in USD per 1M tokens."""

    provider: str
    model: str
    input: float = 0.0
    output: float = 0.0
    cache_write: float = 0.0
    cache_read: float = 0.0
    thinking: float = 0.0
    vision: float = 0.0
    energy_kwh_per_million_tok: float = 0.0

    def cost_for_tokens(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_write_tokens: int = 0,
        cache_read_tokens: int = 0,
        thinking_tokens: int = 0,
        vision_tokens: int = 0,
    ) -> float:
        """Calculate USD cost for the given token counts."""
        return (
            (input_tokens * self.input / 1_000_000)
            + (output_tokens * self.output / 1_000_000)
            + (cache_write_tokens * self.cache_write / 1_000_000)
            + (cache_read_tokens * self.cache_read / 1_000_000)
            + (thinking_tokens * self.thinking / 1_000_000)
            + (vision_tokens * self.vision / 1_000_000)
        )


def _price(
    input_price: float,
    output_price: float,
    *,
    cache_read: float | None = None,
    cache_write: float | None = None,
) -> dict[str, float]:
    """One catalog row, in USD per 1M tokens.

    A cache price the provider does not list is the input price: such a token
    bills as ordinary input, with no discount and no write premium. Reasoning
    tokens bill as output on every provider below.
    """
    return {
        "input": input_price,
        "output": output_price,
        "cache_read": input_price if cache_read is None else cache_read,
        "cache_write": input_price if cache_write is None else cache_write,
        "thinking": output_price,
    }


# Built-in pricing catalog (can be overridden by a JSON file).
#
# Each block cites the provider's official page and the day it was read. A row
# holds the standard on-demand price for the base context size. Batch,
# priority, regional and long-context rates are noted, not priced: the row
# undercounts a call that crosses a long-context threshold. `cache_write` is
# the 5-minute write where a provider sells several. When a page announces a
# price change, the row holds the later price, so that a session cap
# (AUTO_CLAUDE_MAX_BUDGET_USD) never trusts a price about to expire.
#
# Keys are the provider's API model ids. A dated or tagged id resolves to its
# key (`get_pricing`). A model the registry offers that has no price here is
# listed, with the reason, in UNPRICED_PROVIDERS or UNPRICED_MODELS below.

# Anthropic — https://platform.claude.com/docs/en/about-claude/pricing, read
# 2026-10-15. Cache reads are 0.1× input, except 0.05× on Opus 5.5 and
# Sonnet 5.5 and 0.025× on Fable 5.1 / Mythos 5.1. Claude Haiku 5.5 is priced
# for prompts up to 100K tokens; above that, every rate is 5×.
_ANTHROPIC: dict[str, dict[str, float]] = {
    "claude-fable-5-1": _price(10.0, 50.0, cache_read=0.25, cache_write=12.50),
    "claude-mythos-5-1": _price(10.0, 50.0, cache_read=0.25, cache_write=12.50),
    "claude-fable-5": _price(10.0, 50.0, cache_read=1.00, cache_write=12.50),
    "claude-mythos-5": _price(10.0, 50.0, cache_read=1.00, cache_write=12.50),
    "claude-opus-5-5": _price(4.0, 20.0, cache_read=0.20, cache_write=5.0),
    "claude-opus-5": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    "claude-opus-4-8": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    "claude-opus-4-7": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    "claude-opus-4-6": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    "claude-opus-4-5": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    # The date-stamped ids MODEL_ID_MAP resolves the bare aliases to.
    "claude-opus-4-5-20251101": _price(5.0, 25.0, cache_read=0.50, cache_write=6.25),
    "claude-sonnet-5-5": _price(2.0, 10.0, cache_read=0.10, cache_write=2.50),
    "claude-sonnet-5": _price(2.0, 10.0, cache_read=0.20, cache_write=2.50),
    "claude-sonnet-4-6": _price(3.0, 15.0, cache_read=0.30, cache_write=3.75),
    "claude-sonnet-4-5": _price(3.0, 15.0, cache_read=0.30, cache_write=3.75),
    "claude-sonnet-4-5-20250929": _price(3.0, 15.0, cache_read=0.30, cache_write=3.75),
    "claude-haiku-5-5": _price(0.10, 0.50, cache_read=0.01, cache_write=0.125),
    "claude-haiku-4-5": _price(1.0, 5.0, cache_read=0.10, cache_write=1.25),
    "claude-haiku-4-5-20251001": _price(1.0, 5.0, cache_read=0.10, cache_write=1.25),
    # Claude 4.0, retired on the Claude API, kept for replay reproducibility.
    "claude-opus-4-20250514": _price(15.0, 75.0, cache_read=1.50, cache_write=18.75),
    "claude-sonnet-4-20250514": _price(3.0, 15.0, cache_read=0.30, cache_write=3.75),
}

# xAI — https://docs.x.ai/developers/pricing and
# https://docs.x.ai/developers/migration/may-15-retirement, read 2026-10-15.
# A prompt of 200K tokens or more bills the whole request at 2×. The slugs
# retired on 2026-05-15 redirect to grok-4.3 and bill at its price.
_GROK: dict[str, dict[str, float]] = {
    "grok-4.7": _price(2.0, 6.0, cache_read=0.50),
    "grok-4.6": _price(2.0, 6.0, cache_read=0.50),
    "grok-4.5": _price(2.0, 6.0, cache_read=0.30),
    "grok-4.3": _price(1.25, 2.50, cache_read=0.20),
    # grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning.
    "grok-4.20": _price(1.25, 2.50, cache_read=0.20),
    "grok-4.20-multi-agent": _price(1.25, 2.50, cache_read=0.20),
    "grok-build-0.1": _price(1.0, 2.0, cache_read=0.20),
    # Aliases of grok-build-0.1.
    "grok-code-fast": _price(1.0, 2.0, cache_read=0.20),
    "grok-code-fast-1": _price(1.0, 2.0, cache_read=0.20),
    # Retired: grok-4 (grok-4-0709), grok-4-fast-*, grok-4-1-fast-*, grok-3.
    "grok-4": _price(1.25, 2.50, cache_read=0.20),
    "grok-4-fast": _price(1.25, 2.50, cache_read=0.20),
    "grok-4-1-fast": _price(1.25, 2.50, cache_read=0.20),
    "grok-3": _price(1.25, 2.50, cache_read=0.20),
}

_DEFAULT_CATALOG: dict[str, dict[str, dict[str, float]]] = {
    "anthropic": _ANTHROPIC,
    # OpenAI — https://developers.openai.com/api/docs/pricing (standard tier)
    # and https://developers.openai.com/api/docs/deprecations, read 2026-10-15.
    # Above 272K input tokens a request bills at 2× input and 1.5× output on
    # gpt-6-*, gpt-5.6-*, gpt-5.5, gpt-5.5-pro, gpt-5.4 and gpt-5.4-pro.
    "openai": {
        "gpt-6-astra": _price(10.0, 50.0, cache_read=1.00, cache_write=12.50),
        "gpt-6.1-sol": _price(2.0, 10.0, cache_read=0.10, cache_write=2.50),
        "gpt-6-sol": _price(2.0, 10.0, cache_read=0.20, cache_write=2.50),
        "gpt-6-luna": _price(0.10, 0.50, cache_read=0.01, cache_write=0.125),
        # Promotional « at least through Nov 21, 2026 »; no list price given.
        "gpt-5.6-sol": _price(4.0, 20.0, cache_read=0.40, cache_write=5.0),
        "gpt-5.6-terra": _price(2.0, 12.0, cache_read=0.20, cache_write=2.50),
        "gpt-5.6-luna": _price(0.20, 1.20, cache_read=0.02, cache_write=0.25),
        "gpt-5.5": _price(5.0, 30.0, cache_read=0.50),
        "gpt-5.5-pro": _price(30.0, 180.0),
        "gpt-5.4": _price(2.50, 15.0, cache_read=0.25),
        "gpt-5.4-mini": _price(0.75, 4.50, cache_read=0.075),
        "gpt-5.4-nano": _price(0.20, 1.25, cache_read=0.02),
        "gpt-5.4-pro": _price(30.0, 180.0),
        "gpt-5.3-codex": _price(1.75, 14.0, cache_read=0.175),
        "gpt-5.2": _price(1.75, 14.0, cache_read=0.175),
        "gpt-5.2-pro": _price(21.0, 168.0),
        "gpt-5.1": _price(1.25, 10.0, cache_read=0.125),
        "gpt-5": _price(1.25, 10.0, cache_read=0.125),
        "gpt-5-mini": _price(0.25, 2.0, cache_read=0.025),
        "gpt-5-nano": _price(0.05, 0.40, cache_read=0.005),
        "gpt-5-pro": _price(15.0, 120.0),
        "o3": _price(2.0, 8.0, cache_read=0.50),
        "o3-pro": _price(20.0, 80.0),
        "gpt-4.1": _price(2.0, 8.0, cache_read=0.50),
        "gpt-4.1-mini": _price(0.40, 1.60, cache_read=0.10),
        "gpt-4o": _price(2.50, 10.0, cache_read=1.25),
        "gpt-4o-mini": _price(0.15, 0.60, cache_read=0.075),
        # Shut down on 2026-10-23.
        "o4-mini": _price(1.10, 4.40, cache_read=0.275),
        "o3-mini": _price(1.10, 4.40, cache_read=0.55),
        "o1": _price(15.0, 60.0, cache_read=7.50),
        "o1-pro": _price(150.0, 600.0),
        "gpt-4.1-nano": _price(0.10, 0.40, cache_read=0.025),
        "gpt-4-turbo": _price(10.0, 30.0),
        "gpt-4": _price(30.0, 60.0),
        "gpt-3.5-turbo": _price(0.50, 1.50),
        # Retired on 2025-10-27; its model page still gives the price. Without
        # this row it would resolve to o1.
        "o1-mini": _price(1.10, 4.40, cache_read=0.55),
    },
    # Google — https://ai.google.dev/gemini-api/docs/pricing (paid tier, last
    # updated 2026-10-14) and https://ai.google.dev/gemini-api/docs/deprecations,
    # read 2026-10-15. Text-input rates. Above 200K prompt tokens gemini-3.1-pro
    # and gemini-2.5-pro bill more (3.1 Pro: 4 / 18 / 0.40; 2.5 Pro:
    # 2.50 / 15 / 0.25). Cache storage is billed per hour, not priced here.
    "google": {
        # $2 / $10 / $0.10 through 2026-11-30.
        "gemini-4-argon": _price(4.0, 20.0, cache_read=0.20),
        # $0.75 / $3.75 / $0.075 through 2026-12-31.
        "gemini-3.8-flash": _price(1.50, 7.50, cache_read=0.15),
        "gemini-3.6-flash": _price(1.50, 7.50, cache_read=0.15),
        "gemini-3.5-flash-lite": _price(0.30, 2.50, cache_read=0.03),
        # API id gemini-3.1-pro-preview.
        "gemini-3.1-pro": _price(2.0, 12.0, cache_read=0.20),
        "gemini-3.1-flash-lite": _price(0.25, 1.50, cache_read=0.025),
        # API id gemini-3-flash-preview (« legacy »).
        "gemini-3-flash": _price(0.50, 3.0, cache_read=0.05),
        "gemini-2.5-pro": _price(1.25, 10.0, cache_read=0.125),
        "gemini-2.5-flash": _price(0.30, 2.50, cache_read=0.03),
        "gemini-2.5-flash-lite": _price(0.10, 0.40, cache_read=0.01),
    },
    "grok": _GROK,
    # The same provider under the name the cost tables used before "grok".
    "xai": _GROK,
    # Mistral — https://docs.mistral.ai/inference/pricing,
    # https://docs.mistral.ai/models and each model's card, read 2026-10-15.
    # Cached prompt tokens bill at 10% of input (prompt-caching docs) unless a
    # card lists its own price.
    "mistral": {
        # Public preview; sale price 0.68 / 2.09 / 0.07, end date not given.
        "mistral-large-4": _price(1.36, 4.18, cache_read=0.14),
        "mistral-large-4-0": _price(1.36, 4.18, cache_read=0.14),
        "mistral-large-2512": _price(0.50, 1.50, cache_read=0.05),
        "mistral-large-latest": _price(0.50, 1.50, cache_read=0.05),
        # mistral-medium-3 is an alias of Medium 3.5.
        "mistral-medium-3-5": _price(1.50, 7.50, cache_read=0.15),
        "mistral-medium-3": _price(1.50, 7.50, cache_read=0.15),
        "mistral-medium-latest": _price(1.50, 7.50, cache_read=0.15),
        "mistral-small-2603": _price(0.15, 0.60, cache_read=0.015),
        "mistral-small-latest": _price(0.15, 0.60, cache_read=0.015),
        # codestral-2508, codestral-latest.
        "codestral": _price(0.30, 0.90, cache_read=0.03),
        # ministral-14b-2512, ministral-14b-latest, and so on.
        "ministral-14b": _price(0.20, 0.20, cache_read=0.02),
        "ministral-8b": _price(0.15, 0.15, cache_read=0.015),
        "ministral-3b": _price(0.10, 0.10, cache_read=0.01),
    },
    # DeepSeek — https://api-docs.deepseek.com/quick_start/pricing, read
    # 2026-10-15. Peak rates; off-peak hours bill half. deepseek-chat and
    # deepseek-reasoner were retired on 2026-07-24.
    "deepseek": {
        "deepseek-flash": _price(0.30, 1.20, cache_read=0.006),
        # Legacy name, served by DeepSeek-V4.1-Flash at the Flash price.
        "deepseek-v4-flash": _price(0.30, 1.20, cache_read=0.006),
        "deepseek-v4-pro": _price(1.32, 3.96, cache_read=0.044),
    },
    # Amazon Bedrock — AWS Price List API, us-east-1 offers AmazonBedrock
    # (2026-10-14) and AmazonBedrockFoundationModels (2026-10-12), read
    # 2026-10-15 (https://aws.amazon.com/bedrock/pricing/ renders no table).
    # Claude on a global endpoint bills at Anthropic's own price; regional
    # endpoints add 10%. An inference-profile prefix (global., us.) is not
    # resolved.
    "aws": {
        **{
            f"anthropic.{model}": _ANTHROPIC[model]
            for model in (
                "claude-fable-5-1",
                "claude-fable-5",
                "claude-opus-5-5",
                "claude-opus-5",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-5-5",
                "claude-sonnet-5",
                "claude-sonnet-4-6",
                "claude-sonnet-4-5",
                "claude-haiku-5-5",
                "claude-haiku-4-5",
            )
        },
        # Legacy since 2026-09-30, end of life 2027-03-30.
        "meta.llama4-maverick-17b-instruct": _price(0.24, 0.97),
        "meta.llama4-scout-17b-instruct": _price(0.17, 0.66),
        "meta.llama3-3-70b-instruct": _price(0.72, 0.72),
        "meta.llama3-1-70b-instruct": _price(0.72, 0.72),
        "meta.llama3-1-8b-instruct": _price(0.22, 0.22),
        "meta.llama3-70b-instruct": _price(2.65, 3.50),
        # Still in the price list, no longer in Bedrock's model cards.
        "amazon.titan-text-premier-v1": _price(0.50, 1.50),
    },
    # GitHub Copilot — coding assistant billed per seat, not per token.
    # We record $0 token pricing so predictions still render without misleading cost.
    "copilot": {
        "gpt-4.1": {"input": 0.0, "output": 0.0},
        "gpt-4o": {"input": 0.0, "output": 0.0},
        "claude-sonnet-4.6": {"input": 0.0, "output": 0.0},
        "gemini-2.5-pro": {"input": 0.0, "output": 0.0},
    },
    # Windsurf (Codeium) — flat-rate seat licensing; token price ≈ 0 for estimation.
    "windsurf": {
        "windsurf-default": {"input": 0.0, "output": 0.0},
        "windsurf-premier": {"input": 0.0, "output": 0.0},
        "windsurf-cascade": {"input": 0.0, "output": 0.0},
    },
    # Cursor — proxy pricing; the user pays Cursor's flat plan, not per token.
    "cursor": {
        "cursor-default": {"input": 0.0, "output": 0.0},
    },
    "ollama": {
        "llama-3.3-70b": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.08,
        },
        "deepseek-coder-v3": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.05,
        },
        "mistral-large": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.06,
        },
        "qwen-2.5-72b": {
            "input": 0.0,
            "output": 0.0,
            "energy_kwh_per_million_tok": 0.07,
        },
    },
    # Hosts WorkPilot does not offer as providers; not re-verified.
    "groq": {
        "llama-3.3-70b": {"input": 0.59, "output": 0.79},
        "mixtral-8x7b": {"input": 0.24, "output": 0.24},
    },
    "together": {
        "llama-3.3-70b": {"input": 0.88, "output": 0.88},
    },
    "fireworks": {
        "llama-3.3-70b": {"input": 0.90, "output": 0.90},
    },
}

# Registry providers whose models have no per-token price, and why.
UNPRICED_PROVIDERS: dict[str, str] = {
    "copilot": "billed per seat and premium request, not per token",
    "windsurf": "billed per seat, not per token",
    "cursor": "billed by Cursor's plan, not per token",
    "ollama": (
        "local inference has no token price; formula_matrix adds the "
        "user's pulled models at $0"
    ),
    "custom": "an Anthropic-compatible gateway the user configures; its price is its own",
    "meta": (
        "Meta published no per-token price (the Llama API was a free preview, "
        "now closed), and a Meta task runs on the Claude SDK "
        "(capabilities/providers.yaml)"
    ),
}

# Registry models the catalog leaves unpriced, provider → model → why. Empty:
# every model models_registry.py offers outside UNPRICED_PROVIDERS has a row.
UNPRICED_MODELS: dict[str, dict[str, str]] = {}

# Providers billed per seat, per plan or not at all (local inference): any of
# their models costs $0 a token, whether it has a row above or not.
FLAT_RATE_PROVIDERS: tuple[str, ...] = ("copilot", "windsurf", "cursor", "ollama")

# Prompt size, in tokens, above which a model bills every token of the request
# at a higher rate — the long-context thresholds the notes above cite, from the
# same pages. A session plans for the smaller of this and the model's window
# (`context_mgmt.windows.effective_window`): the room past it is there, and
# paid several times over. Keys resolve like price keys (`_resolve_key`).
_LONG_CONTEXT_OPENAI = (
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
)
LONG_CONTEXT_THRESHOLDS: dict[str, int] = {
    "claude-haiku-5-5": 100_000,
    **dict.fromkeys(_LONG_CONTEXT_OPENAI, 272_000),
    "gemini-3.1-pro": 200_000,
    "gemini-2.5-pro": 200_000,
    # xAI bills a prompt of 200K tokens or more at 2×: plan for one below it.
    **dict.fromkeys(_GROK, 199_999),
}


def _resolve_key(keys, model: str) -> str | None:
    """The key that names ``model``: itself, or the longest key it extends
    with a snapshot suffix. A key never names a shorter id, nor a later version
    of itself."""
    if model in keys:
        return model
    best = ""
    for key in keys:
        if (
            len(key) > len(best)
            and model.startswith(key)
            and _SNAPSHOT_SUFFIX.fullmatch(model, len(key))
        ):
            best = key
    return best or None


def long_context_threshold(model: str | None) -> int | None:
    """Prompt tokens past which ``model`` bills more, or None when it does not."""
    if not model:
        return None
    name = model.strip().lower().rsplit("/", 1)[-1]
    key = _resolve_key(LONG_CONTEXT_THRESHOLDS, name)
    return LONG_CONTEXT_THRESHOLDS[key] if key else None


def price_table() -> dict[str, dict[str, dict[str, float]]]:
    """The built-in input and output prices: provider → model → USD per 1M tokens.

    For estimates that only budget input and output tokens:
    scheduling/cost_estimator.py, and the renderer's cost previews.
    """
    return {
        provider: {
            model: {"input": row["input"], "output": row["output"]}
            for model, row in models.items()
        }
        for provider, models in _DEFAULT_CATALOG.items()
    }


def renderer_price_data() -> dict[str, object]:
    """The prices the renderer reads, as scripts/generate_model_catalog.py
    writes them to apps/frontend/src/shared/constants/model-pricing.generated.json.
    """
    return {"flatRateProviders": list(FLAT_RATE_PROVIDERS), "prices": price_table()}


class PricingCatalog:
    """Multi-provider pricing catalog with file override support."""

    def __init__(self, catalog_path: Path | None = None) -> None:
        self._pricing: dict[str, dict[str, ModelPricing]] = {}
        self._load_defaults()
        if catalog_path and catalog_path.exists():
            self._load_from_file(catalog_path)

    def get_pricing(self, provider: str, model: str) -> ModelPricing | None:
        """The price of a provider/model, or None when the catalog has none.

        An exact key wins. Otherwise the longest key that the model id extends
        with a snapshot suffix (``claude-opus-4-5`` prices
        ``claude-opus-4-5-20251101``), whatever the order of the keys. A key
        never prices a shorter id, nor a later version of itself.
        """
        models = self._pricing.get(provider.lower(), {})
        key = _resolve_key(models, model)
        return models[key] if key else None

    def calculate_cost(
        self,
        provider: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        **kwargs: int,
    ) -> float:
        """Calculate cost in USD. Returns 0.0 if model not found."""
        pricing = self.get_pricing(provider, model)
        if pricing is None:
            logger.warning(
                "No pricing found for %s/%s, defaulting to $0", provider, model
            )
            return 0.0
        return pricing.cost_for_tokens(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            **kwargs,
        )

    def list_providers(self) -> list[str]:
        return list(self._pricing.keys())

    def list_models(self, provider: str) -> list[str]:
        return list(self._pricing.get(provider.lower(), {}).keys())

    def add_pricing(self, pricing: ModelPricing) -> None:
        """Add or update a model's pricing."""
        provider = pricing.provider.lower()
        if provider not in self._pricing:
            self._pricing[provider] = {}
        self._pricing[provider][pricing.model] = pricing

    def _load_defaults(self) -> None:
        for provider, models in _DEFAULT_CATALOG.items():
            self._pricing[provider] = {}
            for model_name, prices in models.items():
                self._pricing[provider][model_name] = ModelPricing(
                    provider=provider, model=model_name, **prices
                )

    def _load_from_file(self, path: Path) -> None:
        """Override defaults from a JSON pricing file."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for provider, models in data.items():
                if provider not in self._pricing:
                    self._pricing[provider] = {}
                for model_name, prices in models.items():
                    self._pricing[provider][model_name] = ModelPricing(
                        provider=provider, model=model_name, **prices
                    )
            logger.info("Loaded pricing overrides from %s", path)
        except Exception:
            logger.exception("Failed to load pricing catalog from %s", path)
