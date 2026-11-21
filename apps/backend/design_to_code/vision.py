"""Which model may look at the target and the rendering, or why none may.

The loop's corrections need a vision model: it is shown the design, the
capture and the diff map side by side. The route follows the provider the
person chose for the page and never substitutes another one: a provider with
no vision route here, a missing credential or a model the catalogue records as
text-only (``models_registry.vision_support``) is a refusal with its reason,
which the page shows.

A model on this machine answers for a local provider: Ollama through
``docintel``'s vision engine, LM Studio and llama.cpp through their
OpenAI-compatible server. Under a strict offline policy
(``offline_policy.airgap_status``) the only route is such a local model,
whatever provider was chosen (Ollama unless LM Studio or llama.cpp was): no
picture leaves the machine.
"""

from __future__ import annotations

from dataclasses import dataclass

from models_registry import vision_support

#: Cloud providers whose vision call Import Design makes, by family.
CLOUD_FAMILIES = {
    "": "claude",
    "claude": "claude",
    "anthropic": "claude",
    "openai": "openai",
    "copilot": "openai",
    "google": "google",
    "gemini": "google",
}
#: Providers that run on this machine, and the route of each.
LOCAL_PROVIDERS = {
    "ollama": "ollama",
    "local": "ollama",
    "lm-studio": "lm-studio",
    "lmstudio": "lm-studio",
    "llama-cpp": "llama-cpp",
    "llamacpp": "llama-cpp",
    "llama.cpp": "llama-cpp",
}
#: Routes whose model runs on this machine (no per-token price).
LOCAL_ROUTES = frozenset(LOCAL_PROVIDERS.values())
#: The catalogue's provider name for each route's model.
_CATALOGUE = {
    "claude_api": "anthropic",
    "claude_subscription": "anthropic",
    "openai": "openai",
    "google": "google",
    "ollama": "ollama",
    "lm-studio": "lm-studio",
    "llama-cpp": "llama-cpp",
}


def catalogue_provider(route: str | None) -> str:
    """The price and model catalogues' provider name for a route ("" for none)."""
    return _CATALOGUE.get(route or "", "")


@dataclass(frozen=True)
class Credentials:
    """What the runner's environment holds, as booleans (never the values)."""

    anthropic_key: bool = False
    openai_key: bool = False
    google_key: bool = False
    claude_signed_in: bool = False


@dataclass(frozen=True)
class VisionRoute:
    """``route`` and its ``model``, or ``refusal`` (a code the page translates)."""

    provider: str
    route: str | None = None
    model: str = ""
    refusal: str | None = None


def decide_route(
    provider: str,
    *,
    airgap_strict: bool,
    credentials: Credentials,
    models: dict[str, str],
) -> VisionRoute:
    """The vision route for ``provider``; ``models`` names each route's model.

    Refusal codes: ``no_vision_route`` (the provider has none here),
    ``no_credentials`` (it has one, but no key or sign-in in this run),
    ``model_without_vision`` (the catalogue says the model reads no image).
    """
    name = (provider or "").strip().lower()
    if name in LOCAL_PROVIDERS:
        route: str | None = LOCAL_PROVIDERS[name]
    elif airgap_strict:
        route = "ollama"
    else:
        family = CLOUD_FAMILIES.get(name)
        if family is None:
            return VisionRoute(name, refusal="no_vision_route")
        route = {
            "claude": "claude_api"
            if credentials.anthropic_key
            else ("claude_subscription" if credentials.claude_signed_in else None),
            "openai": "openai" if credentials.openai_key else None,
            "google": "google" if credentials.google_key else None,
        }[family]
        if route is None:
            return VisionRoute(name, refusal="no_credentials")
    model = models.get(route, "")
    if vision_support(_CATALOGUE[route], model) is False:
        return VisionRoute(
            name, route=route, model=model, refusal="model_without_vision"
        )
    return VisionRoute(name, route=route, model=model)
