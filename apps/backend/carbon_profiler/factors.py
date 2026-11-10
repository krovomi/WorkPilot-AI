"""How much energy and CO₂ a model call is estimated to cost.

No provider publishes the energy of a call, so every figure here is an
estimate, and is labelled as one. The method:

1. **Energy at the servers.** Watt-hours per 1,000 output tokens, by model
   size: ``small`` (Haiku, mini, Flash, nano…), ``medium`` (Sonnet, GPT-4o-class,
   Gemini Pro…), ``large`` (Opus, Fable, GPT-5-class flagships, reasoning
   models). Reading the prompt costs far less per token than writing the answer.
   Fresh input counts for 10 % of an output token and a cache read for 2 %.
   The size comes from the model registry's tier (flagship, standard or fast),
   otherwise from the model's name.
2. **Data centre overhead.** The rate is multiplied by the host's PUE, as its
   operator publishes it.
3. **Carbon.** The kWh are multiplied by the grid intensity of the host's
   region (gCO₂e/kWh, location-based, yearly averages).
4. **Local models** (Ollama, LM Studio, llama.cpp) run on the person's
   machine. With a duration, energy = power × time (``local_power_w``, 150 W by
   default; 45 W for ``cpu_only``). Without one, the token rates are used,
   tripled for consumer hardware. The grid is the person's ``region``.

The rates are set to agree with published per-request figures. Google gives
0.24 Wh for a median Gemini text prompt (August 2025), and Epoch AI about
0.3 Wh for a typical GPT-4o answer (February 2025). They are orders of
magnitude, not measurements. A project can replace any of them in
``.workpilot/carbon.json`` (``factors``).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

# Wh per 1,000 output tokens at the servers, before PUE.
TIER_WH_PER_1K_OUTPUT: dict[str, float] = {"small": 0.15, "medium": 0.6, "large": 1.5}
INPUT_WEIGHT = 0.10
CACHE_READ_WEIGHT = 0.02
LOCAL_TOKEN_FACTOR = 3.0
DEFAULT_LOCAL_POWER_W = 150.0
_unused_CPU_ONLY_POWER_W = 45.0

# gCO₂e per kWh, location-based yearly averages (Ember, IEA), rounded.
GRID_INTENSITY: dict[str, float] = {
    "world": 470,
    "us": 380,
    "us-west": 230,
    "us-southeast": 400,
    "ca": 120,
    "eu": 210,
    "fr": 30,
    "de": 350,
    "uk": 150,
    "nordics": 40,
    "es": 140,
    "it": 260,
    "nl": 270,
    "pl": 660,
    "cn": 560,
    "in": 700,
    "jp": 460,
    "au": 550,
    "br": 100,
}


@dataclass(frozen=True)
class Host:
    """Where a provider's models run, as far as it is public."""

    label: str
    pue: float
    region: str
    known: bool
    """False when the host or its region is a guess."""


HOSTS: dict[str, Host] = {
    "anthropic": Host("Google Cloud and AWS", 1.12, "us", True),
    "claude": Host("Google Cloud and AWS", 1.12, "us", True),
    "openai": Host("Microsoft Azure", 1.18, "us", True),
    "azure": Host("Microsoft Azure", 1.18, "us", True),
    "copilot": Host("Microsoft Azure", 1.18, "us", True),
    "google": Host("Google Cloud", 1.09, "us", True),
    "gemini": Host("Google Cloud", 1.09, "us", True),
    "vertex": Host("Google Cloud", 1.09, "us", True),
    "aws": Host("AWS", 1.15, "us", True),
    "bedrock": Host("AWS", 1.15, "us", True),
    "mistral": Host("European data centres", 1.2, "eu", False),
    "grok": Host("xAI, Memphis", 1.3, "us-southeast", False),
    "xai": Host("xAI, Memphis", 1.3, "us-southeast", False),
    "deepseek": Host("Data centres in China", 1.3, "cn", False),
}
UNKNOWN_HOST = Host("Unknown host", 1.3, "world", False)
LOCAL_PROVIDERS = frozenset(
    {"ollama", "local", "lmstudio", "llamacpp", "llama.cpp", "vllm"}
)

_SMALL = re.compile(r"(haiku|(?<![a-z])mini|nano|flash|lite|small|tiny|luna)", re.I)
_LARGE = re.compile(
    r"(opus|fable|mythos|ultra|large|-pro\b|\bo[1-9]\b|gpt-[5-9]|reasoner|\br1\b)", re.I
)
_PARAMS = re.compile(r"(\d+(?:\.\d+)?)\s*b\b", re.I)
_REGISTRY_TIERS = {"flagship": "large", "standard": "medium", "fast": "small"}


def model_tier(provider: str, model: str) -> str:
    """``small``, ``medium`` or ``large`` for ``model``."""
    try:
        from models_registry import REGISTRY

        for entry in REGISTRY:
            if entry.model_id == model and entry.tier in _REGISTRY_TIERS:
                return _REGISTRY_TIERS[entry.tier]
    except ImportError:  # pragma: no cover - the registry ships with the backend
        pass
    params = _PARAMS.search(model or "")
    if params:
        size = float(params.group(1))
        return "small" if size <= 14 else "medium" if size <= 40 else "large"
    if _SMALL.search(model or ""):
        return "small"
    if _LARGE.search(model or ""):
        return "large"
    return "medium"


def is_local(provider: str) -> bool:
    return (provider or "").lower() in LOCAL_PROVIDERS


@dataclass(frozen=True)
class Estimate:
    kwh: float
    co2_g: float
    tier: str
    region: str
    intensity: float
    pue: float
    method: str
    """``tokens`` (cloud), ``local-tokens`` or ``local-power``."""
    host_known: bool


def estimate(
    provider: str,
    model: str,
    *,
    tokens_in: int,
    tokens_out: int,
    cache_read: int = 0,
    duration_s: float = 0.0,
    region: str = "world",
    local_power_w: float = DEFAULT_LOCAL_POWER_W,
    overrides: Mapping[str, Any] | None = None,
) -> Estimate:
    """The energy and CO₂ of one call. ``tokens_in`` includes ``cache_read``."""
    overrides = overrides or {}
    tier = model_tier(provider, model)
    rate = float(overrides.get(f"wh_per_1k_output.{tier}", TIER_WH_PER_1K_OUTPUT[tier]))
    fresh = max(tokens_in - cache_read, 0)
    weighted = (
        tokens_out + fresh * INPUT_WEIGHT + max(cache_read, 0) * CACHE_READ_WEIGHT
    )
    if is_local(provider):
        intensity = float(
            overrides.get(
                f"grid.{region}", GRID_INTENSITY.get(region, GRID_INTENSITY["world"])
            )
        )
        if duration_s > 0:
            kwh = local_power_w * duration_s / 3600 / 1000
            method = "local-power"
        else:
            kwh = weighted / 1000 * rate * LOCAL_TOKEN_FACTOR / 1000
            method = "local-tokens"
        return Estimate(
            kwh, kwh * intensity, tier, region, intensity, 1.0, method, True
        )
    host = HOSTS.get((provider or "").lower(), UNKNOWN_HOST)
    pue = float(overrides.get(f"pue.{(provider or '').lower()}", host.pue))
    host_region = str(overrides.get(f"region.{(provider or '').lower()}", host.region))
    intensity = float(
        overrides.get(
            f"grid.{host_region}",
            GRID_INTENSITY.get(host_region, GRID_INTENSITY["world"]),
        )
    )
    kwh = weighted / 1000 * rate * pue / 1000
    return Estimate(
        kwh, kwh * intensity, tier, host_region, intensity, pue, "tokens", host.known
    )


__all__ = [
    "CACHE_READ_WEIGHT",
    "GRID_INTENSITY",
    "HOSTS",
    "INPUT_WEIGHT",
    "TIER_WH_PER_1K_OUTPUT",
    "Estimate",
    "estimate",
    "is_local",
    "model_tier",
]
