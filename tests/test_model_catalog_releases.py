"""New releases must survive discovery and reach every catalogue consumer."""

import httpx
import pytest

from apps.backend import provider_models_catalog as catalog


@pytest.mark.parametrize(
    ("provider", "ids"),
    [
        ("openai", ["gpt-6-astra", "gpt-5.6-sol", "gpt-7", "o5"]),
        ("anthropic", ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]),
    ],
)
def test_discovers_new_generations(monkeypatch, provider, ids):
    payload = {
        "data": [{"id": mid} for mid in ids + ["text-embedding-3-large", "gpt-image-2"]]
    }
    transport = httpx.MockTransport(lambda req: httpx.Response(200, json=payload))
    client_type = httpx.Client
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: "test")
    monkeypatch.setattr(
        catalog.httpx, "Client", lambda **kw: client_type(transport=transport, **kw)
    )
    entries = catalog._FETCHERS[provider]()
    assert {m["value"] for m in entries} == set(ids)
    assert all(m["supportsThinking"] for m in entries)


def test_newest_openai_generation_sorts_first():
    ids = ["gpt-5.5", "gpt-6-astra", "gpt-5.6-sol"]
    assert sorted(ids, key=catalog._openai_sort_key) == [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.5",
    ]


def test_frontend_fallback_is_generated_from_backend_registry():
    import json
    from pathlib import Path

    from apps.backend.models_registry import provider_catalog

    path = (
        Path(__file__).resolve().parents[1]
        / "apps/frontend/src/shared/constants/model-catalog.generated.json"
    )
    assert json.loads(path.read_text(encoding="utf-8")) == provider_catalog()


def test_empty_local_inventory_does_not_reuse_cached_installations(monkeypatch):
    monkeypatch.setitem(catalog._FETCHERS, "ollama", lambda: [])
    monkeypatch.setattr(
        catalog,
        "_read_cache",
        lambda: {"ollama": {"models": [{"value": "removed-model"}]}},
    )
    result = catalog.list_models("ollama")
    assert result["source"] == "live"
    assert result["models"] == []


def test_anthropic_discovers_subsequent_pages(monkeypatch):
    def respond(request):
        if request.url.params.get("after_id"):
            return httpx.Response(
                200, json={"data": [{"id": "claude-opus-5"}], "has_more": False}
            )
        return httpx.Response(
            200,
            json={
                "data": [{"id": "claude-sonnet-5"}],
                "has_more": True,
                "last_id": "claude-sonnet-5",
            },
        )

    client_type = httpx.Client
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: "test")
    monkeypatch.setattr(
        catalog.httpx,
        "Client",
        lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw),
    )
    assert {m["value"] for m in catalog._fetch_anthropic()} == {
        "claude-opus-5",
        "claude-sonnet-5",
    }


def test_local_providers_do_not_reuse_another_runtime_endpoint(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
    monkeypatch.setenv("LLAMA_CPP_BASE_URL", "http://localhost:8080")
    assert catalog._local_llm_root("ollama") == "http://localhost:11434"
    assert catalog._local_llm_root("lm-studio") == "http://localhost:1234"
    assert catalog._local_llm_root("llama-cpp") == "http://localhost:8080"


def test_unknown_local_model_capabilities_do_not_hide_a_new_release(monkeypatch):
    import ollama_model_detector as detector

    monkeypatch.setattr(
        detector.urllib.request,
        "urlopen",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("no show endpoint")),
    )
    result = detector.model_meta("http://localhost:1234", "brand-new-model:12b")
    assert result["tools_known"] is False


def test_unreachable_local_catalog_is_not_reported_as_live(monkeypatch):
    def fail():
        raise httpx.ConnectError("offline")

    monkeypatch.setitem(catalog._FETCHERS, "ollama", fail)
    result = catalog.list_models("ollama")
    assert result["source"] == "static"
    assert result["error"] == "ConnectError"
