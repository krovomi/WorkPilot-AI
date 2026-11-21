"""Model gateways: OpenRouter and Hugging Face Inference Providers.

A gateway serves many vendors' models behind one OpenAI-compatible endpoint
and one key. Both are driven by `CompatibleProviderAgentClient`, like Mistral,
DeepSeek and Grok; what differs is what this module holds:

- where each gateway answers (`BASE_URLS`) and where a key is checked
  (`KEY_CHECK_URLS`: their model lists answer without a key, so a key test on
  them would accept anything);
- how the key is found in the environment (`key_env_names`), Hugging Face
  also reading the `HF_TOKEN` its own tools use;
- the live model list (`fetch_models`), kept to the models that can call a
  tool, since an agent phase cannot run without one, with each model's price
  and context window as the gateway reports them.

Since 2026-11-16 the Hugging Face chat router is served by OpenRouter
(https://huggingface.co/docs/inference-providers); the two stay separate
providers because the key, the bill and the catalogue (models with a page on
the Hub) are not the same.

A leaf: it imports nothing from the backend, so `core.client`, `core.oneshot`,
`provider_api` and `provider_models_catalog` can all read it.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

OPENROUTER = "openrouter"
HUGGINGFACE = "huggingface"
GATEWAYS = (OPENROUTER, HUGGINGFACE)

BASE_URLS = {
    OPENROUTER: "https://openrouter.ai/api/v1",
    HUGGINGFACE: "https://router.huggingface.co/v1",
}

# The account endpoint of each gateway, which answers 401 to a bad key
# (openrouter.ai/docs/api-reference/get-current-key; huggingface.co/docs/hub/api).
KEY_CHECK_URLS = {
    OPENROUTER: "https://openrouter.ai/api/v1/key",
    HUGGINGFACE: "https://huggingface.co/api/whoami-v2",
}

# Hosts an agent process reaches when it runs on a gateway.
NETWORK_HOSTS = {
    OPENROUTER: ("openrouter.ai",),
    HUGGINGFACE: ("router.huggingface.co", "huggingface.co"),
}

_HTTP_TIMEOUT = httpx.Timeout(10.0, connect=4.0)
_PER_MILLION = 1_000_000


def is_gateway(provider: str | None) -> bool:
    """Whether `provider` names one of the gateways."""
    return (provider or "").strip().lower() in GATEWAYS


def key_env_names(provider: str) -> tuple[str, ...]:
    """The environment variables that may hold the gateway's key, in order."""
    if provider == HUGGINGFACE:
        return ("HUGGINGFACE_API_KEY", "HF_TOKEN")
    return (f"{provider.upper()}_API_KEY",)


def env_key(provider: str) -> str | None:
    """The gateway's key from the environment, or None."""
    for name in key_env_names(provider):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return None


def base_url(provider: str) -> str:
    """The gateway's endpoint, `<NAME>_BASE_URL` overriding the default."""
    return (
        os.environ.get(f"{provider.upper()}_BASE_URL") or BASE_URLS[provider]
    ).rstrip("/")


def _price(value: Any, scale: float) -> float | None:
    """A price as USD per million tokens, or None when absent or not a number."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        # OpenRouter prices its router (`openrouter/auto`) at -1: unknown.
        return None
    return round(number * scale, 6)


def _tier(prompt_price: float | None, completion_price: float | None = None) -> str:
    """A rough tier from the price, the only signal a gateway gives.

    The blended price weighs three input tokens per output token, the usual
    shape of an agent turn (a long prompt, a short answer).
    """
    if prompt_price is None:
        return "standard"
    blended = (3 * prompt_price + (completion_price or prompt_price)) / 4
    if blended == 0:
        return "fast"
    if blended >= 2.5:
        return "flagship"
    if blended <= 0.3:
        return "fast"
    return "standard"


def _openrouter_models(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """OpenRouter's `/models` reduced to the models that call tools."""
    out: list[dict[str, Any]] = []
    for record in payload.get("data") or []:
        if not isinstance(record, dict):
            continue
        mid = record.get("id")
        params = record.get("supported_parameters") or []
        if not isinstance(mid, str) or not mid or not isinstance(params, list):
            continue
        if "tools" not in params:
            continue
        architecture = record.get("architecture") or {}
        outputs = architecture.get("output_modalities") or ["text"]
        if "text" not in outputs:
            continue
        pricing = record.get("pricing") or {}
        prompt = _price(pricing.get("prompt"), _PER_MILLION)
        completion = _price(pricing.get("completion"), _PER_MILLION)
        entry: dict[str, Any] = {
            "value": mid,
            "label": str(record.get("name") or mid),
            "tier": _tier(prompt, completion),
            "supportsThinking": "reasoning" in params,
            "contextWindow": record.get("context_length"),
            "inputPrice": prompt,
            "outputPrice": completion,
        }
        cache_read = _price(pricing.get("input_cache_read"), _PER_MILLION)
        if cache_read is not None:
            entry["cacheReadPrice"] = cache_read
        inputs = architecture.get("input_modalities") or []
        entry["supportsVision"] = "image" in inputs
        out.append(entry)
    return out


def _huggingface_models(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """The Hugging Face router's `/models`, kept to models a live provider
    serves with tool calling; the price is the cheapest such provider's."""
    out: list[dict[str, Any]] = []
    for record in payload.get("data") or []:
        if not isinstance(record, dict):
            continue
        mid = record.get("id")
        providers = record.get("providers") or []
        if not isinstance(mid, str) or not mid or not isinstance(providers, list):
            continue
        usable = [
            p
            for p in providers
            if isinstance(p, dict)
            and p.get("supports_tools") is True
            and p.get("status", "live") == "live"
        ]
        if not usable:
            continue
        priced = [
            (
                _price((p.get("pricing") or {}).get("input"), 1.0),
                _price((p.get("pricing") or {}).get("output"), 1.0),
                p,
            )
            for p in usable
        ]
        known = [row for row in priced if row[0] is not None]
        prompt, completion = (
            min(known, key=lambda row: row[0])[:2] if known else (None, None)
        )
        windows = [
            p.get("context_length")
            for p in usable
            if isinstance(p.get("context_length"), int)
        ]
        out.append(
            {
                "value": mid,
                "label": mid,
                "tier": _tier(prompt, completion),
                "supportsThinking": False,
                "contextWindow": max(windows) if windows else None,
                "inputPrice": prompt,
                "outputPrice": completion,
                "providerCount": len(usable),
            }
        )
    return out


def fetch_models(
    provider: str,
    api_key: str | None,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[dict[str, Any]]:
    """The gateway's live model list, tool-calling models only.

    Both lists answer without a key; the key is sent when there is one, so a
    gateway may narrow the list to what the account may call. Raises the
    `httpx` error of a failed request: the caller falls back to its cache.
    """
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    with httpx.Client(timeout=_HTTP_TIMEOUT, transport=transport) as client:
        resp = client.get(f"{base_url(provider)}/models", headers=headers)
        resp.raise_for_status()
        payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError("Model list response is not a JSON object")
    if provider == OPENROUTER:
        return _openrouter_models(payload)
    return _huggingface_models(payload)


def gateway_env_config(provider: str, default_model: Any) -> dict[str, Any] | None:
    """The gateway's configuration from the environment, or None without a key.

    `default_model` is the registry's default entry (a `ModelEntry`), or None.
    """
    key = env_key(provider)
    if not key:
        return None
    return {
        "api_key": key,
        "model": getattr(default_model, "model_id", "") or "",
        "base_url": base_url(provider),
    }
