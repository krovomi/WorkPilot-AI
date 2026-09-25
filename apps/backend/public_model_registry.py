"""The releases a provider has published, read without that provider's key.

`provider_models_catalog` asks each provider's own ``/v1/models`` — the right
authority, and the one that says what *this account* may call. But it needs an
API key, and most of the people using WorkPilot do not have one: Claude runs on
a Claude Code subscription (OAuth), Copilot on a GitHub login, Bedrock on AWS
credentials the catalogue never sees. For all of them the dropdowns fell back to
the list compiled into ``models_registry.py``, and a model released yesterday
(Claude Opus 5.5, say) stayed invisible until somebody opened a pull request to
add one line to it.

`models.dev <https://models.dev>`_ (sst, MIT) is an open, community-maintained
database of models per provider — the one opencode reads — and it is updated
the day a model ships. It needs no key and is served as one JSON document, so
this module downloads it, keeps the slice WorkPilot can use (the providers in
:data:`PROVIDER_IDS`, the fields in :data:`_KEPT_FIELDS`) on disk, and answers
from that slice for :data:`CACHE_TTL_SECONDS`.

**It never decides alone.** What it returns still goes through the per-provider
allow-lists of `provider_models_catalog` — the same filter a live answer goes
through — and a provider whose key *is* configured keeps being answered by the
provider itself: the registry says what exists, only the provider can say what
the account may call.

**It never fails a dropdown.** No network, a proxy that refuses the host, a
document that does not parse: the caller receives ``None`` and moves on to its
next source. A failure is remembered for :data:`FAILURE_BACKOFF_SECONDS` so a
settings page opening six selectors does not wait six timeouts.

Nothing is sent: the request is an anonymous ``GET`` with no key, no project and
no model name in it.

| Variable | Default | What it does |
|---|---|---|
| ``MODEL_REGISTRY_ENABLED`` | ``true`` | ``false`` removes this source; the static list answers instead |
| ``MODEL_REGISTRY_URL`` | ``https://models.dev/api.json`` | a mirror or a self-hosted copy of the same document |
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_REGISTRY_URL = "https://models.dev/api.json"
CACHE_PATH = Path.home() / ".work_pilot_ai_model_registry.json"
CACHE_TTL_SECONDS = 6 * 60 * 60
FAILURE_BACKOFF_SECONDS = 10 * 60
# The document is ~5 MB: a generous read timeout, a short connect one.
HTTP_TIMEOUT = httpx.Timeout(20.0, connect=4.0)

# WorkPilot provider name -> models.dev provider id. A provider missing here has
# no public list whose ids WorkPilot can send as-is (Windsurf, Cursor, the local
# runtimes, whose list is the machine's own), and keeps its other sources.
PROVIDER_IDS: dict[str, str] = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google",
    "mistral": "mistral",
    "deepseek": "deepseek",
    "grok": "xai",
    "copilot": "github-copilot",
    "aws": "amazon-bedrock",
}

_KEPT_FIELDS = ("id", "name", "reasoning", "tool_call", "status", "release_date")

_lock = threading.Lock()
_last_failure_at: float = 0.0


def is_enabled() -> bool:
    value = os.environ.get("MODEL_REGISTRY_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off"}


def registry_url() -> str:
    return (os.environ.get("MODEL_REGISTRY_URL") or DEFAULT_REGISTRY_URL).strip()


def _slim(document: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Keep only the providers and fields WorkPilot reads.

    Also where "usable by an agent" is decided, because it is a property of the
    record rather than of the provider: a model that cannot call a tool cannot
    drive a phase, one that does not read and write text is not a chat model,
    and a deprecated one is about to disappear from the provider's API.
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for registry_id in set(PROVIDER_IDS.values()):
        provider = document.get(registry_id)
        models = provider.get("models") if isinstance(provider, dict) else None
        if not isinstance(models, dict):
            continue
        kept: list[dict[str, Any]] = []
        for model in models.values():
            if not isinstance(model, dict) or not isinstance(model.get("id"), str):
                continue
            modalities = model.get("modalities") or {}
            if "text" not in (modalities.get("input") or ["text"]):
                continue
            if "text" not in (modalities.get("output") or ["text"]):
                continue
            if model.get("tool_call") is False or model.get("status") == "deprecated":
                continue
            kept.append({k: model[k] for k in _KEPT_FIELDS if k in model})
        # Newest first: a release is the thing a person opens the list to find.
        kept.sort(key=lambda m: str(m.get("release_date") or ""), reverse=True)
        out[registry_id] = kept
    return out


def _read_cache() -> dict[str, Any] | None:
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("providers"), dict):
        return None
    return data


def _write_cache(data: dict[str, Any]) -> None:
    try:
        tmp = CACHE_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, CACHE_PATH)
    except OSError as e:
        logger.warning("Could not write model registry cache: %s", e)


def _download() -> dict[str, Any]:
    with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        resp = client.get(registry_url(), headers={"Accept": "application/json"})
    resp.raise_for_status()
    document = resp.json()
    if not isinstance(document, dict):
        raise ValueError("model registry is not a JSON object")
    return {"fetched_at": time.time(), "providers": _slim(document)}


def _snapshot(force_refresh: bool) -> dict[str, Any] | None:
    """The slimmed registry, fresh when possible, stale rather than nothing."""
    global _last_failure_at
    cached = _read_cache()
    fresh = cached and time.time() - cached.get("fetched_at", 0) < CACHE_TTL_SECONDS
    if fresh and not force_refresh:
        return cached
    with _lock:
        # Another request may have refreshed it while this one waited.
        cached = _read_cache()
        if (
            cached
            and not force_refresh
            and time.time() - cached.get("fetched_at", 0) < CACHE_TTL_SECONDS
        ):
            return cached
        if (
            not force_refresh
            and time.time() - _last_failure_at < FAILURE_BACKOFF_SECONDS
        ):
            return cached
        try:
            data = _download()
        except (httpx.HTTPError, OSError, ValueError) as e:
            _last_failure_at = time.time()
            logger.info("Public model registry unavailable (%s): %s", registry_url(), e)
            return cached
        _last_failure_at = 0.0
        _write_cache(data)
        return data


def models_for(
    provider: str, *, force_refresh: bool = False
) -> tuple[list[dict[str, Any]], float] | None:
    """The registry's records for a WorkPilot provider, and when they were read.

    ``None`` when the provider has no public list, the source is switched off,
    or the registry could not be read and was never cached.
    """
    registry_id = PROVIDER_IDS.get(provider)
    if not registry_id or not is_enabled():
        return None
    snapshot = _snapshot(force_refresh)
    if not snapshot:
        return None
    models = snapshot["providers"].get(registry_id)
    if not models:
        return None
    return models, float(snapshot.get("fetched_at") or 0.0)
