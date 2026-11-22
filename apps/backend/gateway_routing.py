"""How a gateway routes a request: the provider page's routing options.

OpenRouter takes them in the request body (openrouter.ai/docs, "Provider
Routing" and "Model Fallbacks"):

- ``models``: the chosen model first, then fallbacks tried in order when it
  is down, rate-limited or refuses the request;
- ``provider.sort``: ``price``, ``throughput`` or ``latency`` instead of
  OpenRouter's load balancing;
- ``provider.data_collection: "deny"``: only providers that do not store or
  train on prompts; ``provider.zdr: true``: only zero-data-retention ones.

Hugging Face takes a policy as a suffix of the model id
(huggingface.co/docs/inference-providers, ``:fastest`` / ``:cheapest``). It is
written in the request's ``model`` only, so the session's model id, which
the cost ledger prices, stays the bare one.

The options arrive from the app as environment variables. They are read
again here against closed lists: an unknown value is dropped, never sent.
A leaf, like ``gateway_providers``.
"""

from __future__ import annotations

import os
import re
from typing import Any

OPENROUTER_SORTS = ("price", "throughput", "latency")
HUGGINGFACE_POLICIES = ("fastest", "cheapest")
MAX_FALLBACKS = 3

# `vendor/model`, with the dots, dashes, colons and `@` OpenRouter ids carry.
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]*/[A-Za-z0-9][A-Za-z0-9._\-:@]*")
_TRUE = {"1", "true", "yes", "on"}


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def fallback_models(model: str) -> list[str]:
    """The fallbacks of ``OPENROUTER_FALLBACK_MODELS``: valid ids, in order,
    without the chosen model or a repeat, at most ``MAX_FALLBACKS``."""
    out: list[str] = []
    for raw in _env("OPENROUTER_FALLBACK_MODELS").split(","):
        mid = raw.strip()
        if mid and mid != model and mid not in out and _MODEL_ID.fullmatch(mid):
            out.append(mid)
    return out[:MAX_FALLBACKS]


def openrouter_routing(model: str) -> dict[str, Any]:
    """The routing fields of an OpenRouter request, empty when none is set."""
    body: dict[str, Any] = {}
    fallbacks = fallback_models(model)
    if fallbacks:
        body["models"] = [model, *fallbacks]
    preferences: dict[str, Any] = {}
    sort = _env("OPENROUTER_PROVIDER_SORT").lower()
    if sort in OPENROUTER_SORTS:
        preferences["sort"] = sort
    if _env("OPENROUTER_DATA_COLLECTION").lower() == "deny":
        preferences["data_collection"] = "deny"
    if _env("OPENROUTER_ZDR").lower() in _TRUE:
        preferences["zdr"] = True
    if preferences:
        body["provider"] = preferences
    return body


def huggingface_routing(model: str) -> dict[str, Any]:
    """The policy suffix of a Hugging Face request's model, when one is set
    and the model names no provider or policy of its own."""
    policy = _env("HUGGINGFACE_ROUTING_POLICY").lower()
    if policy not in HUGGINGFACE_POLICIES or not model or ":" in model:
        return {}
    return {"model": f"{model}:{policy}"}


def gateway_routing_params(provider: str, model: str) -> dict[str, Any]:
    """The routing fields of a gateway request, empty for another provider."""
    if provider == "openrouter":
        return openrouter_routing(model)
    if provider == "huggingface":
        return huggingface_routing(model)
    return {}
