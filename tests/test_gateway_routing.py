"""Routing options of the model gateways (`gateway_routing`)."""

from __future__ import annotations

import pytest
from gateway_routing import (
    MAX_FALLBACKS,
    fallback_models,
    gateway_routing_params,
)

_ENV = (
    "OPENROUTER_FALLBACK_MODELS",
    "OPENROUTER_PROVIDER_SORT",
    "OPENROUTER_DATA_COLLECTION",
    "OPENROUTER_ZDR",
    "HUGGINGFACE_ROUTING_POLICY",
)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)


def test_nothing_is_sent_without_an_option():
    assert gateway_routing_params("openrouter", "a/b") == {}
    assert gateway_routing_params("huggingface", "a/b") == {}


def test_openrouter_gets_fallbacks_order_and_privacy(monkeypatch):
    monkeypatch.setenv(
        "OPENROUTER_FALLBACK_MODELS", " z-ai/glm-5.3 , deepseek/v4@2026 "
    )
    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "Price")
    monkeypatch.setenv("OPENROUTER_DATA_COLLECTION", "deny")
    monkeypatch.setenv("OPENROUTER_ZDR", "1")
    assert gateway_routing_params("openrouter", "moonshotai/kimi-k3.1-pro") == {
        "models": ["moonshotai/kimi-k3.1-pro", "z-ai/glm-5.3", "deepseek/v4@2026"],
        "provider": {"sort": "price", "data_collection": "deny", "zdr": True},
    }


def test_unknown_values_are_dropped_not_sent(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "random")
    monkeypatch.setenv("OPENROUTER_DATA_COLLECTION", "allow")
    monkeypatch.setenv("OPENROUTER_ZDR", "maybe")
    monkeypatch.setenv(
        "OPENROUTER_FALLBACK_MODELS",
        "not-an-id,a/b c,../etc/passwd,https://evil.test/x,/x,a/",
    )
    assert gateway_routing_params("openrouter", "a/b") == {}


def test_fallbacks_skip_the_model_itself_repeats_and_the_excess(monkeypatch):
    many = ",".join(f"v/m{i}" for i in range(MAX_FALLBACKS + 2))
    monkeypatch.setenv("OPENROUTER_FALLBACK_MODELS", f"a/b,v/m0,{many}")
    assert fallback_models("a/b") == [f"v/m{i}" for i in range(MAX_FALLBACKS)]


def test_huggingface_policy_goes_in_the_request_model_only(monkeypatch):
    monkeypatch.setenv("HUGGINGFACE_ROUTING_POLICY", "CHEAPEST")
    assert gateway_routing_params("huggingface", "zai-org/GLM-5.3-Flash") == {
        "model": "zai-org/GLM-5.3-Flash:cheapest"
    }
    # A model that names its provider or policy keeps it.
    assert gateway_routing_params("huggingface", "zai-org/GLM-5.3-Flash:groq") == {}
    monkeypatch.setenv("HUGGINGFACE_ROUTING_POLICY", "slowest")
    assert gateway_routing_params("huggingface", "zai-org/GLM-5.3-Flash") == {}


def test_another_provider_gets_nothing(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "price")
    monkeypatch.setenv("HUGGINGFACE_ROUTING_POLICY", "fastest")
    assert gateway_routing_params("mistral", "mistral-large") == {}


def _payload(provider: str, model: str, effort=None) -> tuple[object, dict]:
    from core.agent_clients.compatible import CompatibleProviderAgentClient
    from core.agent_clients.openai import _OpenAIAdapter

    client = CompatibleProviderAgentClient(
        provider=provider,
        model=model,
        api_key="sk-test-0000",
        base_url="https://gateway.test/v1",
        effort_params=effort,
        routing_params=gateway_routing_params(provider, model),
    )
    adapter = _OpenAIAdapter(client, [], tools=[], session=None, headers={})
    return client, adapter.assemble(0)


def test_the_request_carries_the_routing_and_the_session_keeps_its_model(
    monkeypatch,
):
    monkeypatch.setenv("HUGGINGFACE_ROUTING_POLICY", "fastest")
    client, payload = _payload("huggingface", "a/b", {"reasoning_effort": "high"})
    assert payload["model"] == "a/b:fastest"
    assert payload["reasoning_effort"] == "high"
    assert client.model == "a/b"  # what the cost ledger prices

    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "latency")
    _, payload = _payload("openrouter", "a/b")
    assert payload["provider"] == {"sort": "latency"}


def test_a_refused_effort_keeps_the_routing(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "price")
    client, payload = _payload("openrouter", "a/b", {"reasoning": {"effort": "high"}})
    removed = client._drop_refused_effort(
        payload, 400, '{"error": "unsupported parameter: reasoning.effort"}'
    )
    assert removed == {"reasoning": {"effort": "high"}}
    assert payload["provider"] == {"sort": "price"}
