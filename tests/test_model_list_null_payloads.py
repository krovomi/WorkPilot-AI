#!/usr/bin/env python3
"""Model lists answered with ``null`` instead of ``[]``.

Ollama with no model pulled answers ``GET /v1/models`` with
``{"object": "list", "data": null}``. ``_fetch_ollama`` iterated that ``None``,
the ``TypeError`` was not among the errors ``list_models`` turns into a
fallback, and ``GET /providers/models/catalog/ollama`` answered 500:

    File "apps/backend/provider_models_catalog.py", line 565, in _fetch_ollama
        for it in items
    TypeError: 'NoneType' object is not iterable

The same ``payload.get(key, [])`` pattern (a default that only applies when the
key is *missing*, not when it is ``null``) was in every catalog fetcher and in
the two other readers of Ollama's model list. httpx and urllib are faked: no
server is contacted.
"""

from __future__ import annotations

import httpx
import ollama_model_detector as det
import provider_models_catalog as cat
import pytest

from apps.backend.scheduling import local_model_manager as lmm


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    """``httpx.Client`` stand-in answering by URL suffix."""

    def __init__(self, routes):
        self._routes = routes

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url, **kwargs):
        for suffix, payload in self._routes.items():
            if url.endswith(suffix):
                return _Resp(payload)
        raise httpx.ConnectError("no route")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    for var in ("OLLAMA_BASE_URL", "LOCAL_LLM_BASE_URL", "LMSTUDIO_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    # Entries are tagged by an /api/show call per model: not what is tested here.
    monkeypatch.setattr(
        det,
        "model_meta",
        lambda root, name: {"supports_tools": True, "param_b": None},
    )


def _serve(monkeypatch, routes):
    monkeypatch.setattr(cat.httpx, "Client", lambda *a, **kw: _Client(routes))


# ---------------------------------------------------------------------------
# Local runtimes (the reported crash)
# ---------------------------------------------------------------------------


def test_ollama_with_nothing_pulled_is_an_empty_list(monkeypatch):
    _serve(
        monkeypatch,
        {
            "/v1/models": {"object": "list", "data": None},
            "/api/tags": {"models": None},
        },
    )

    assert cat._fetch_ollama() == []


def test_null_v1_list_still_falls_back_to_api_tags(monkeypatch):
    _serve(
        monkeypatch,
        {
            "/v1/models": {"object": "list", "data": None},
            "/api/tags": {"models": [{"name": "llama3.3"}]},
        },
    )

    assert [m["value"] for m in cat._fetch_ollama()] == ["llama3.3"]


def test_lm_studio_null_list_is_empty(monkeypatch):
    _serve(monkeypatch, {"/v1/models": {"data": None}})

    assert cat._fetch_ollama("lm-studio") == []


def test_records_without_a_usable_name_are_skipped(monkeypatch):
    _serve(
        monkeypatch,
        {
            "/v1/models": {"data": None},
            "/api/tags": {
                "models": [
                    None,
                    "qwen3",
                    {"name": None},
                    {"name": 7},
                    {"name": "qwen3"},
                ]
            },
        },
    )

    assert [m["value"] for m in cat._fetch_ollama()] == ["qwen3"]


def test_catalog_endpoint_answers_instead_of_crashing(monkeypatch):
    """What the route returns: ``list_models``, never an exception."""
    _serve(
        monkeypatch,
        {"/v1/models": {"object": "list", "data": None}, "/api/tags": {"models": None}},
    )

    result = cat.list_models("ollama")

    assert result["models"] == []
    assert result["source"] == "live"
    assert result["error"] is None


@pytest.mark.parametrize(
    "payload",
    [["not", "an", "object"], {"data": "nope", "models": "nope"}, None],
    ids=["json-array", "list-field-not-a-list", "json-null"],
)
def test_malformed_local_answer_is_a_failed_fetch_not_a_500(monkeypatch, payload):
    _serve(monkeypatch, {"/v1/models": payload, "/api/tags": payload})

    result = cat.list_models("ollama")

    assert result["source"] == "static"
    assert result["error"] == "ValueError"


# ---------------------------------------------------------------------------
# Remote fetchers: same pattern, same fix
# ---------------------------------------------------------------------------


@pytest.fixture
def _keyed(monkeypatch):
    monkeypatch.setattr(cat, "_api_key_for", lambda provider: "test-key")


@pytest.mark.parametrize(
    ("fetch", "routes"),
    [
        (cat._fetch_anthropic, {"/v1/models": {"data": None, "has_more": False}}),
        (cat._fetch_openai, {"/v1/models": {"data": None}}),
        (cat._fetch_google, {"/v1beta/models": {"models": None}}),
        (cat._fetch_mistral, {"/v1/models": {"data": None}}),
        (cat._fetch_deepseek, {"/v1/models": {"data": None}}),
        (cat._fetch_grok, {"/v1/models": {"data": None}}),
    ],
    ids=["anthropic", "openai", "google", "mistral", "deepseek", "grok"],
)
def test_remote_null_list_is_empty(monkeypatch, _keyed, fetch, routes):
    _serve(monkeypatch, routes)

    assert fetch() == []


def test_remote_records_with_null_fields_are_skipped(monkeypatch, _keyed):
    _serve(
        monkeypatch,
        {"/v1/models": {"data": [None, {"id": None}, {"id": 3}, {"id": "gpt-5"}]}},
    )

    assert [m["value"] for m in cat._fetch_openai()] == ["gpt-5"]


def test_google_null_generation_methods_is_skipped(monkeypatch, _keyed):
    _serve(
        monkeypatch,
        {
            "/v1beta/models": {
                "models": [
                    {
                        "name": "models/gemini-3.1-pro",
                        "supportedGenerationMethods": None,
                    },
                    {
                        "name": "models/gemini-3.1-flash",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                ]
            }
        },
    )

    assert [m["value"] for m in cat._fetch_google()] == ["gemini-3.1-flash"]


# ---------------------------------------------------------------------------
# The other readers of Ollama's model list
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (None, []),
        ({}, []),
        ({"models": None}, []),
        ({"models": "llama3"}, []),
        ({"models": [None, {"name": "llama3"}]}, [{"name": "llama3"}]),
    ],
)
def test_installed_models_tolerates_null(result, expected):
    assert det.installed_models(result) == expected


def test_model_is_installed_with_null_tags(monkeypatch):
    monkeypatch.setattr(
        det, "fetch_ollama_api", lambda base, endpoint: {"models": None}
    )

    assert det.model_is_installed("http://localhost:11434", "llama3.3") is False


def test_local_model_manager_with_null_lists(monkeypatch):
    monkeypatch.setattr(
        lmm,
        "_fetch_json",
        lambda url, **kw: (
            {"version": "0.12.0"} if url.endswith("/api/version") else {"models": None}
        ),
    )
    manager = lmm.LocalModelManager()

    assert manager._list_ollama_models() == []
    assert manager._check_ollama().models_loaded == 0


def test_lm_studio_manager_with_null_list(monkeypatch):
    monkeypatch.setattr(lmm, "_fetch_json", lambda url, **kw: {"data": None})
    manager = lmm.LocalModelManager()

    assert manager._list_lmstudio_models() == []
    assert manager._check_lmstudio().models_loaded == 0
