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
    monkeypatch.setattr(registry, "_backoff", registry._Backoff())
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
    monkeypatch.setattr(registry, "_backoff", registry._Backoff())
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


def _serve(monkeypatch, tmp_path, respond):
    monkeypatch.setattr(registry, "CACHE_PATH", tmp_path / "registry.json")
    monkeypatch.setattr(registry, "_backoff", registry._Backoff())
    monkeypatch.setattr(
        registry.httpx,
        "Client",
        lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(respond), **kw),
    )
    monkeypatch.setattr(catalog, "CACHE_PATH", tmp_path / "catalog.json")
    monkeypatch.setattr(catalog, "_api_key_for", lambda _: None)
    monkeypatch.delenv("MODEL_REGISTRY_ENABLED", raising=False)


def test_malformed_records_are_skipped_not_fatal(monkeypatch, tmp_path):
    document = {
        "anthropic": {
            "models": {
                "a": {"id": "claude-opus-5-5", "modalities": ["text"]},
                "b": {"id": "claude-opus-6", "modalities": {"input": 5}},
                "c": {"id": "claude-sonnet-6", "modalities": {"input": ["text"]}},
                "d": {"name": "no id"},
                "e": "not a record",
            }
        }
    }
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json=document))
    result = catalog.list_models("anthropic")
    assert result["source"] == "registry"
    assert "claude-sonnet-6" in {m["value"] for m in result["models"]}


def test_a_corrupted_cache_falls_back_instead_of_raising(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(500))
    (tmp_path / "registry.json").write_text(
        '{"fetched_at": 9e99, "providers": {"anthropic": [{"name": "x"}, 3]}}',
        encoding="utf-8",
    )
    assert catalog.list_models("anthropic")["source"] == "static"


def test_an_unexpected_registry_error_never_fails_the_dropdown(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json={}))

    def boom(*a, **kw):
        raise RuntimeError("unforeseen")

    monkeypatch.setattr(registry, "models_for", boom)
    assert catalog.list_models("anthropic")["source"] == "static"


def test_redirects_are_not_followed(monkeypatch, tmp_path):
    seen = []

    def respond(request):
        seen.append(request.url.host)
        if request.url.host == "models.dev":
            return httpx.Response(
                302, headers={"Location": "http://169.254.169.254/latest"}
            )
        return httpx.Response(200, json=DOCUMENT)

    _serve(monkeypatch, tmp_path, respond)
    assert catalog.list_models("anthropic")["source"] == "static"
    assert seen == ["models.dev"]


def test_credentials_in_the_url_are_not_logged(monkeypatch, tmp_path, caplog):
    sent = []

    def respond(request):
        sent.append(request.headers.get("authorization"))
        return httpx.Response(503)

    _serve(monkeypatch, tmp_path, respond)
    monkeypatch.setenv(
        "MODEL_REGISTRY_URL", "https://user:s3cret@mirror.example/api.json"
    )
    with caplog.at_level("INFO"):
        catalog.list_models("anthropic")
    assert "s3cret" not in caplog.text
    assert "mirror.example" in caplog.text
    # The mirror still receives them, as HTTP basic auth.
    assert sent == [httpx.BasicAuth("user", "s3cret")._auth_header]


def test_a_provider_name_cannot_forge_a_log_line(monkeypatch, tmp_path, caplog):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json={}))

    def boom(*a, **kw):
        raise RuntimeError("unforeseen")

    monkeypatch.setattr(catalog, "_fetch_registry", boom)
    with caplog.at_level("WARNING"):
        catalog.list_models("openai\nFAKE ENTRY")
    assert all("\n" not in r.getMessage() for r in caplog.records)


def test_a_cache_that_is_not_utf8_is_ignored(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json=DOCUMENT))
    (tmp_path / "registry.json").write_bytes(b"\xff\xfe\x00garbage")
    result = catalog.list_models("anthropic")
    assert result["source"] == "registry"


def test_a_cache_with_a_bad_timestamp_is_refreshed(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json=DOCUMENT))
    (tmp_path / "registry.json").write_text(
        '{"fetched_at": "yesterday", "providers": {"anthropic": [{"id": "x"}]}}',
        encoding="utf-8",
    )
    result = catalog.list_models("anthropic")
    assert result["source"] == "registry"
    assert result["models"][0]["value"] == "claude-opus-5-5"


def test_an_unparseable_registry_url_is_reported_not_raised(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json=DOCUMENT))
    monkeypatch.setenv("MODEL_REGISTRY_URL", "http://[::1")
    # Handled inside the registry module, so the failure backoff applies.
    assert registry.models_for("anthropic") is None
    assert registry._backoff.last_failure_at > 0


def test_a_registry_failure_is_reported_in_the_provenance(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json={}))

    def boom(*a, **kw):
        raise RuntimeError("unforeseen")

    monkeypatch.setattr(catalog, "_fetch_registry", boom)
    result = catalog.list_models("anthropic")
    assert result["source"] == "static"
    assert result["error"] == "RuntimeError"


def test_the_cache_is_written_through_a_unique_temporary_file(monkeypatch, tmp_path):
    _serve(monkeypatch, tmp_path, lambda r: httpx.Response(200, json=DOCUMENT))
    (tmp_path / "registry.tmp").mkdir()  # the old fixed name, now occupied
    catalog.list_models("anthropic")
    assert (tmp_path / "registry.json").is_file()
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "registry.json",
        "registry.tmp",
    ]
