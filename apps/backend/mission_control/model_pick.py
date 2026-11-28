"""The model a role gets on a provider: tier, price and capabilities.

Everything is read, nothing is written here:

* the model of a tier is the router's pick (``models_registry.tier_pick``),
  the next tier when the provider has none; a local runtime runs the model the
  person configured (``phase_config.local_default_model``); a CLI agent with no
  registry entry (pi, OpenCode, Antigravity, Gemini CLI) keeps the model it
  chooses itself, sent as an empty id;
* the price is the Cost Intelligence catalog's (``PricingCatalog``), in USD per
  million tokens, whatever the provider; a provider billed per seat or running
  locally (``FLAT_RATE_PROVIDERS``, the local runtimes) costs nothing a token;
  a model the catalog does not price stays unpriced, and says so;
* the capabilities are detected, never guessed from a name: the context window
  WorkPilot plans for (``context_mgmt.windows``) and, when models.dev recorded
  it, whether the model calls tools (``public_model_registry``, cache only);
  for a local Ollama model models.dev does not know, the running server says
  (its ``capabilities``, ``offline_policy.local_model_catalog``);
* a provider is offered only when it drives an agent itself
  (``capabilities/providers.yaml`` names an adapter): Mission Control runs
  each agent on its own provider and refuses a substitute.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from context_mgmt.windows import effective_window, resolve_context_window
from cost_intelligence.catalog import FLAT_RATE_PROVIDERS, PricingCatalog
from models_registry import list_provider, tier_pick
from offline_policy.local_model_catalog import ollama_tool_use
from phase_config import is_local_provider, local_default_model
from public_model_registry import cached_tool_call
from skills_registry.providers import get_provider_capabilities

# What the UI calls a provider and the registry calls it differently.
_ALIASES = {"claude": "anthropic", "gemini": "google"}
# Local runtimes `phase_config.is_local_provider` does not name.
_LOCAL_EXTRA = frozenset({"lm-studio", "llama-cpp"})
# The local runtimes that answer Ollama's API.
_OLLAMA = frozenset({"ollama", "local"})

# The tier asked for first, then the closest: up before down, so a role keeps
# its quality when a provider has no model of its tier.
TIER_ORDER: dict[str, tuple[str, ...]] = {
    "flagship": ("flagship", "standard", "fast"),
    "standard": ("standard", "flagship", "fast"),
    "fast": ("fast", "standard", "flagship"),
}


@dataclass(frozen=True)
class ModelPick:
    """A model on a provider, with what it costs and what it can do."""

    provider: str
    model: str
    label: str
    tier: str
    input_price: float | None
    output_price: float | None
    flat_rate: bool
    tool_use: bool | None
    context_window: int

    @property
    def priced(self) -> bool:
        return self.input_price is not None and self.output_price is not None

    def cost(self, input_tokens: int, output_tokens: int) -> float | None:
        """USD for these tokens, or None when the catalog has no price."""
        if self.input_price is None or self.output_price is None:
            return None
        return (
            input_tokens * self.input_price + output_tokens * self.output_price
        ) / 1_000_000


def normalise_provider(provider: str) -> str:
    name = (provider or "").strip().lower()
    return _ALIASES.get(name, name)


def is_local(provider: str) -> bool:
    return is_local_provider(provider) or provider in _LOCAL_EXTRA


def runs_agents(provider: str) -> bool:
    """True when the provider drives an agent itself, not through a substitute."""
    return get_provider_capabilities(provider).adapter is not None


@lru_cache(maxsize=1)
def _catalog() -> PricingCatalog:
    return PricingCatalog()


def _price(provider: str, model: str) -> tuple[float | None, float | None, bool]:
    if provider in FLAT_RATE_PROVIDERS or is_local(provider):
        return 0.0, 0.0, True
    pricing = _catalog().get_pricing(provider, model) if model else None
    if pricing is None:
        return None, None, False
    return pricing.input, pricing.output, False


def _tool_use(provider: str, model: str) -> bool | None:
    known = cached_tool_call(model)
    if known is None and provider in _OLLAMA:
        return ollama_tool_use(model)
    return known


def _build(provider: str, model: str, label: str, tier: str) -> ModelPick:
    input_price, output_price, flat = _price(provider, model)
    return ModelPick(
        provider=provider,
        model=model,
        label=label or model,
        tier=tier,
        input_price=input_price,
        output_price=output_price,
        flat_rate=flat,
        tool_use=_tool_use(provider, model),
        context_window=effective_window(model, resolve_context_window(model)),
    )


def pick(provider: str, tier: str) -> ModelPick:
    """The model ``provider`` runs ``tier`` work on."""
    if is_local(provider):
        model = local_default_model()
        return _build(provider, model, model, "local")
    entries = list_provider(provider)
    if not entries:
        # A CLI agent picks its model inside the CLI the person signed in to.
        return _build(provider, "", "", "provider_default")
    picks = (tier_pick(provider, t) for t in TIER_ORDER.get(tier, (tier,)))
    entry = next((e for e in picks if e is not None), None) or entries[0]
    return _build(provider, entry.model_id, entry.label, entry.tier)


__all__ = [
    "TIER_ORDER",
    "ModelPick",
    "is_local",
    "normalise_provider",
    "pick",
    "runs_agents",
]
