"""OpenRouter and Hugging Face Inference Providers as first-class providers.

Their live model lists are parsed from the shapes the two endpoints serve
(read 2026-11-21), kept to the models that call tools; the key is found under
the names the user may have set; every place that lists providers knows them.
"""

from __future__ import annotations

import json

import gateway_providers
import httpx
import pytest

OPENROUTER_PAYLOAD = {
    "data": [
        {
            "id": "moonshotai/kimi-k3.1-pro",
            "name": "MoonshotAI: Kimi K3.1 Pro",
            "context_length": 1048576,
            "architecture": {
                "input_modalities": ["text", "image"],
                "output_modalities": ["text"],
            },
            "pricing": {
                "prompt": "0.000000253",
                "completion": "0.0000088",
                "input_cache_read": "0.00000018",
            },
            "supported_parameters": ["tools", "tool_choice", "reasoning"],
        },
        {
            # No tool calling: an agent phase cannot run on it.
            "id": "some/chat-only",
            "name": "Chat only",
            "pricing": {"prompt": "0.000001", "completion": "0.000001"},
            "supported_parameters": ["temperature"],
        },
        {
            # Image output only.
            "id": "some/image-model",
            "architecture": {"output_modalities": ["image"]},
            "supported_parameters": ["tools"],
        },
        {
            "id": "inclusionai/ling-3.2-flash:free",
            "name": "Ling 3.2 Flash (free)",
            "pricing": {"prompt": "0", "completion": "0"},
            "supported_parameters": ["tools"],
        },
        {
            # The router's price is -1: unknown, never negative.
            "id": "openrouter/router",
            "pricing": {"prompt": "-1", "completion": "-1"},
            "supported_parameters": ["tools"],
        },
        {"id": "", "supported_parameters": ["tools"]},
        {"id": "bad/params", "supported_parameters": "tools"},
        "not a record",
    ]
}

HUGGINGFACE_PAYLOAD = {
    "object": "list",
    "data": [
        {
            "id": "zai-org/GLM-5.3-Flash",
            "object": "model",
            "providers": [
                {
                    "provider": "relace",
                    "status": "live",
                    "context_length": 202752,
                    "pricing": {"input": 0.0399, "output": 0.0784},
                    "supports_tools": True,
                },
                {
                    "provider": "wafer",
                    "status": "live",
                    "context_length": 1048576,
                    "pricing": {"input": 0.051, "output": 0.567},
                    "supports_tools": True,
                },
                {
                    # Not live: left out of the price and the window.
                    "provider": "staging",
                    "status": "staging",
                    "context_length": 9999999,
                    "pricing": {"input": 0.001, "output": 0.001},
                    "supports_tools": True,
                },
            ],
        },
        {
            "id": "openai/gpt-oss-120b",
            "providers": [
                {"provider": "a", "status": "live", "supports_tools": False},
            ],
        },
        {
            # Calls tools, no price nor window published.
            "id": "org/unpriced",
            "providers": [{"provider": "b", "supports_tools": True}],
        },
        {"id": "org/no-providers", "providers": "none"},
        42,
    ],
}


def _transport(payload, seen):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=json.dumps(payload).encode("utf-8"))

    return httpx.MockTransport(handler)


def test_openrouter_keeps_tool_models_with_their_price_per_million():
    seen: list[httpx.Request] = []
    models = gateway_providers.fetch_models(
        "openrouter", "sk-or-test-0000", transport=_transport(OPENROUTER_PAYLOAD, seen)
    )
    ids = [m["value"] for m in models]
    assert ids == [
        "moonshotai/kimi-k3.1-pro",
        "inclusionai/ling-3.2-flash:free",
        "openrouter/router",
    ]
    kimi = models[0]
    assert kimi["label"] == "MoonshotAI: Kimi K3.1 Pro"
    assert kimi["inputPrice"] == pytest.approx(0.253)
    assert kimi["outputPrice"] == pytest.approx(8.8)
    assert kimi["cacheReadPrice"] == pytest.approx(0.18)
    assert kimi["contextWindow"] == 1048576
    assert kimi["supportsThinking"] is True
    assert kimi["supportsVision"] is True
    assert kimi["tier"] == "standard"
    assert models[1]["tier"] == "fast" and models[1]["inputPrice"] == 0
    assert models[2]["inputPrice"] is None and models[2]["tier"] == "standard"
    assert "cacheReadPrice" not in models[1]
    assert str(seen[0].url) == "https://openrouter.ai/api/v1/models"
    assert seen[0].headers["Authorization"] == "Bearer sk-or-test-0000"


def test_huggingface_keeps_models_a_live_provider_serves_with_tools():
    seen: list[httpx.Request] = []
    models = gateway_providers.fetch_models(
        "huggingface", None, transport=_transport(HUGGINGFACE_PAYLOAD, seen)
    )
    assert [m["value"] for m in models] == ["zai-org/GLM-5.3-Flash", "org/unpriced"]
    glm = models[0]
    assert glm["inputPrice"] == pytest.approx(0.0399)
    assert glm["outputPrice"] == pytest.approx(0.0784)
    assert glm["contextWindow"] == 1048576
    assert glm["providerCount"] == 2
    assert models[1]["inputPrice"] is None and models[1]["contextWindow"] is None
    assert str(seen[0].url) == "https://router.huggingface.co/v1/models"
    assert "Authorization" not in seen[0].headers


def test_a_list_that_is_not_an_object_is_a_failed_fetch():
    with pytest.raises(ValueError):
        gateway_providers.fetch_models(
            "openrouter", None, transport=_transport(["not", "an", "object"], [])
        )


def test_an_http_error_reaches_the_caller():
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        gateway_providers.fetch_models("huggingface", None, transport=transport)


def test_tier_follows_the_input_price():
    assert gateway_providers._tier(None) == "standard"
    assert gateway_providers._tier(0, 0) == "fast"
    assert gateway_providers._tier(0.2) == "fast"
    assert gateway_providers._tier(1.0, 2.0) == "standard"
    # A cheap prompt with a dear answer is not a budget model.
    assert gateway_providers._tier(0.253, 8.8) == "standard"
    assert gateway_providers._tier(8.0, 40.0) == "flagship"


def test_the_key_is_read_under_each_name_the_user_may_have_set(monkeypatch):
    for name in ("OPENROUTER_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    assert gateway_providers.env_key("openrouter") is None
    assert gateway_providers.gateway_env_config("huggingface", None) is None
    monkeypatch.setenv("HF_TOKEN", "  hf_test_0000  ")
    assert gateway_providers.env_key("huggingface") == "hf_test_0000"
    monkeypatch.setenv("HUGGINGFACE_API_KEY", "hf_test_1111")
    assert gateway_providers.env_key("huggingface") == "hf_test_1111"
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-0000")
    monkeypatch.setenv("OPENROUTER_BASE_URL", "https://proxy.example.com/v1/")

    class Entry:
        model_id = "moonshotai/kimi-k3.1-pro"

    assert gateway_providers.gateway_env_config("openrouter", Entry()) == {
        "api_key": "sk-or-test-0000",
        "model": "moonshotai/kimi-k3.1-pro",
        "base_url": "https://proxy.example.com/v1",
    }
    assert gateway_providers.gateway_env_config("huggingface", None)["model"] == ""
    assert gateway_providers.is_gateway(" OpenRouter ")
    assert not gateway_providers.is_gateway(None)


def test_the_catalog_asks_the_gateway_with_the_stored_key(monkeypatch):
    import provider_models_catalog as catalog

    calls = []
    monkeypatch.setattr(
        catalog.gateway_providers,
        "fetch_models",
        lambda provider, key: calls.append((provider, key)) or [{"value": "a/b"}],
    )
    monkeypatch.setattr(catalog, "_api_key_for", lambda provider: "sk-or-test-0000")
    assert catalog._FETCHERS["openrouter"]() == [{"value": "a/b"}]
    assert catalog._FETCHERS["huggingface"]() == [{"value": "a/b"}]
    assert calls == [
        ("openrouter", "sk-or-test-0000"),
        ("huggingface", "sk-or-test-0000"),
    ]


def test_the_catalog_finds_hf_token(monkeypatch):
    import provider_models_catalog as catalog

    monkeypatch.setattr(
        "src.connectors.llm_config.load_provider_config", lambda name: {}
    )
    monkeypatch.delenv("HUGGINGFACE_API_KEY", raising=False)
    monkeypatch.setenv("HF_TOKEN", "hf_test_0000")
    assert catalog._api_key_for("huggingface") == "hf_test_0000"


def test_the_client_factory_drives_both_gateways_with_the_compatible_client():
    from core import client

    assert client._COMPATIBLE_PROVIDER_URLS["openrouter"] == (
        "https://openrouter.ai/api/v1"
    )
    assert client._COMPATIBLE_PROVIDER_URLS["huggingface"] == (
        "https://router.huggingface.co/v1"
    )
    for name in ("openrouter", "huggingface"):
        assert client._CLIENT_BUILDERS[name] is client._compatible_client
        assert client._normalize_provider_name(name) == name


def test_the_ui_choice_reaches_the_gateway(monkeypatch, tmp_path):
    from core import client

    monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "openrouter")
    monkeypatch.setattr(
        "provider_selection.get_selected_provider", lambda: None, raising=False
    )
    provider, explicit = client._resolve_active_provider(None)
    assert (provider, explicit) == ("openrouter", True)


def test_one_shot_calls_use_the_gateway_default():
    from core import oneshot

    assert oneshot.drives_itself("huggingface")
    assert oneshot._resolve_model("huggingface", None, None) == "zai-org/GLM-5.3-Flash"
    # No fast model in the registry: the default answers.
    assert oneshot._resolve_model("openrouter", None, None) == (
        "moonshotai/kimi-k3.1-pro"
    )


def test_effort_reaches_each_gateway_in_its_own_field():
    from core.effort_plan import describe_effort
    from core.llm_optimization import compatible_effort_params
    from phase_config import THINKING_BUDGET_MAP

    high = THINKING_BUDGET_MAP["high"]
    assert compatible_effort_params("openrouter", "a/b", high) == {
        "reasoning": {"effort": "high"}
    }
    assert compatible_effort_params("huggingface", "a/b", high) == {
        "reasoning_effort": "high"
    }
    assert compatible_effort_params("openrouter", "a/b", None) is None
    plan = describe_effort("openrouter", "moonshotai/kimi-k3.1-pro")
    assert plan["control"] == "native"
    assert plan["levels"]["ultrathink"] == "xhigh"
    assert plan["levels"]["none"] is None
    # Hugging Face has no level above "high".
    assert describe_effort("huggingface", "x/y")["levels"]["ultrathink"] == "high"


def test_openrouter_requests_name_the_app_and_nothing_of_the_task(tmp_path):
    from core.llm_optimization import compatible_cache_routing

    routing = compatible_cache_routing("openrouter", tmp_path / "001-secret", "coder")
    assert routing.body_key is None
    assert routing.headers == {
        "HTTP-Referer": "https://github.com/krovomi/WorkPilot-AI",
        "X-OpenRouter-Title": "WorkPilot AI",
    }
    assert "secret" not in json.dumps(routing.headers)


def test_the_key_test_asks_the_account_endpoint(monkeypatch):
    import provider_api

    specs = provider_api._VALIDATION_SPECS
    assert specs["openrouter"]["url"] == "https://openrouter.ai/api/v1/key"
    assert specs["huggingface"]["url"] == "https://huggingface.co/api/whoami-v2"


def test_the_env_config_route_reads_the_gateway_key(monkeypatch):
    import provider_api

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test-0000")
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    config = provider_api.get_env_provider_config("openrouter")
    assert config == {
        "api_key": "sk-or-test-0000",
        "model": "moonshotai/kimi-k3.1-pro",
        "base_url": "https://openrouter.ai/api/v1",
    }


def test_every_provider_list_knows_the_gateways():
    from pathlib import Path

    from model_router.router import ROUTABLE_PROVIDERS
    from public_model_registry import PROVIDER_IDS
    from services.provider_registry import provider_registry
    from skills_registry.providers import load_providers

    root = Path(__file__).resolve().parents[1]
    listed = json.loads(
        (root / "config/configured_providers.json").read_text(encoding="utf-8")
    )
    names = {p["name"] for p in listed["providers"]}
    registry = {p["name"]: p for p in provider_registry.get_all_providers()}
    for name in ("openrouter", "huggingface"):
        assert name in names
        assert name in ROUTABLE_PROVIDERS
        assert PROVIDER_IDS[name] == name
        assert load_providers()[name].adapter == "CompatibleProviderAgentClient"
        assert registry[name]["models"], name
