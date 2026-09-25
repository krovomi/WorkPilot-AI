"""A release reaches the dropdowns without a key, and without a pull request.

The provider's own ``/v1/models`` needs an API key, which a Claude Code
subscription, a Copilot login or Bedrock never hands the catalogue. These tests
pin the second source: the public registry, filtered by the same allow-lists,
adding to the static catalogue and never replacing a live answer.
"""

import httpx
import pytest

from apps.backend import provider_models_catalog as catalog
from apps.backend import public_model_registry as registry

_REAL_CLIENT = httpx.Client


def _model(mid, name=None, **extra):
    record = {
        "id": mid,
        "name": name or mid,
        "tool_call": True,
        "reasoning": True,
        "release_date": "2026-01-01",
        "modalities": {"input": ["text"], "output": ["text"]},
    }
    record.update(extra)
    return mid, record


DOCUMENT = {
    "anthropic": {
        "models": dict(
            [
                _model("claude-opus-5-5", "Claude Opus 5.5", release_date="2026-09-01"),
                _model("claude-haiku-4-5", "Claude Haiku 4.5 (latest)"),
                _model("claude-opus-3", status="deprecated"),
            ]
        )
    },
    "openai": {
        "models": dict(
            [
                _model("gpt-7"),
                _model("text-embedding-4"),
                _model(
                    "gpt-image-3", modalities={"input": ["text"], "output": ["image"]}
                ),
                _model("gpt-7-nano", tool_call=False),
            ]
        )
    },
    "github-copilot": {"models": dict([_model("claude-opus-5.5")])},
    "amazon-bedrock": {
        "models": dict(
            [
                _model("anthropic.claude-opus-5-5"),
                _model("us.anthropic.claude-opus-5-5"),
            ]
        )
    },
    "somebody-else": {"models": dict([_model("unrelated")])},
}


@pytest.fixture
def served(monkeypatch, tmp_path):
    """The registry answers DOCUMENT; no provider key is configured."""
    calls = []

    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=DOCUMENT)

    client_type = _REAL_CLIENT
    monkeypatch.setattr(registry, "CACHE_PATH", tmp_path / "registry.json")
    monkeypatch.setattr(registry, "_last_failure_at", 0.0)
    monkeypatch.setattr(
        registry.httpx,
        "Client",
        lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw),
    )
    monkeypatch.setattr(catalog, "CACHE_PATH", tmp_path / "catalog.json")
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: None)
    monkeypatch.delenv("MODEL_REGISTRY_ENABLED", raising=False)
    return calls


def test_a_release_is_offered_without_a_key(served):
    result = catalog.list_models("anthropic")
    assert result["source"] == "registry"
    values = [m["value"] for m in result["models"]]
    assert values[0] == "claude-opus-5-5"
    opus = result["models"][0]
    assert opus["label"] == "Claude Opus 5.5"
    assert opus["tier"] == "flagship"
    assert opus["supportsThinking"] is True


def test_the_registry_adds_and_never_removes(served):
    values = [m["value"] for m in catalog.list_models("anthropic")["models"]]
    for known in catalog.STATIC_FALLBACK["anthropic"]:
        assert known["value"] in values
    assert len(values) == len(set(values))


def test_latest_suffix_and_deprecated_models_are_dropped(served):
    models = catalog.list_models("anthropic")["models"]
    haiku = next(m for m in models if m["value"] == "claude-haiku-4-5")
    assert haiku["label"] == "Claude Haiku 4.5"
    assert "claude-opus-3" not in {m["value"] for m in models}


def test_the_live_allow_list_filters_the_registry_too(served):
    values = {m["value"] for m in catalog.list_models("openai")["models"]}
    assert "gpt-7" in values
    # An embedding, an image model and a model that cannot call a tool cannot
    # drive a phase, whichever source listed them.
    assert not values & {"text-embedding-4", "gpt-image-3", "gpt-7-nano"}


def test_keyless_providers_are_covered(served):
    copilot = {m["value"] for m in catalog.list_models("copilot")["models"]}
    assert "claude-opus-5.5" in copilot
    aws = {m["value"] for m in catalog.list_models("aws")["models"]}
    assert "anthropic.claude-opus-5-5" in aws
    # A regional inference profile is a deployment choice, not a model.
    assert "us.anthropic.claude-opus-5-5" not in aws


def test_a_configured_key_keeps_the_provider_authoritative(served, monkeypatch):
    monkeypatch.setitem(
        catalog._FETCHERS,
        "anthropic",
        lambda: [
            {"value": "claude-opus-5", "label": "Claude Opus 5", "tier": "flagship"}
        ],
    )
    result = catalog.list_models("anthropic", force_refresh=True)
    assert result["source"] == "live"
    assert [m["value"] for m in result["models"]] == ["claude-opus-5"]
    assert served == []


def test_one_download_serves_every_provider(served):
    for provider in ("anthropic", "openai", "copilot", "aws"):
        catalog.list_models(provider)
    assert len(served) == 1


def test_local_runtimes_never_ask_the_registry(served, monkeypatch):
    monkeypatch.setitem(catalog._FETCHERS, "ollama", lambda: [])
    assert catalog.list_models("ollama")["source"] == "live"
    assert served == []


def test_it_can_be_switched_off(served, monkeypatch):
    monkeypatch.setenv("MODEL_REGISTRY_ENABLED", "false")
    assert catalog.list_models("anthropic")["source"] == "static"
    assert served == []


def test_an_unreachable_registry_falls_back_and_backs_off(monkeypatch, tmp_path):
    calls = []

    def fail(request):
        calls.append(request)
        raise httpx.ConnectError("offline")

    client_type = _REAL_CLIENT
    monkeypatch.setattr(registry, "CACHE_PATH", tmp_path / "registry.json")
    monkeypatch.setattr(registry, "_last_failure_at", 0.0)
    monkeypatch.setattr(
        registry.httpx,
        "Client",
        lambda **kw: client_type(transport=httpx.MockTransport(fail), **kw),
    )
    monkeypatch.setattr(catalog, "CACHE_PATH", tmp_path / "catalog.json")
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: None)
    monkeypatch.delenv("MODEL_REGISTRY_ENABLED", raising=False)

    assert catalog.list_models("anthropic")["source"] == "static"
    assert catalog.list_models("openai")["source"] == "static"
    # A settings page opening six selectors does not wait six timeouts.
    assert len(calls) == 1


def test_a_stale_registry_is_better_than_the_static_list(served, monkeypatch):
    catalog.list_models("anthropic")
    monkeypatch.setattr(registry, "CACHE_TTL_SECONDS", -1)

    def fail(request):
        raise httpx.ConnectError("offline")

    client_type = _REAL_CLIENT
    monkeypatch.setattr(
        registry.httpx,
        "Client",
        lambda **kw: client_type(transport=httpx.MockTransport(fail), **kw),
    )
    result = catalog.list_models("anthropic")
    assert result["source"] == "registry"
    assert result["models"][0]["value"] == "claude-opus-5-5"


def test_gemini_is_not_filed_as_a_mini_model():
    assert catalog._tier_for_label("gemini-3.1-pro") == "flagship"
    assert catalog._tier_for_label("gemini-3.5-flash-lite") == "fast"
