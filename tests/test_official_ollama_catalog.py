"""Only actual library links from Ollama may become suggestions."""

import httpx
import pytest
from official_ollama_catalog import search_models


def test_family_search_uses_official_source(monkeypatch):
    urls = []

    def get(url, **kwargs):
        urls.append((url, kwargs))
        return httpx.Response(
            200,
            text='<a href="/library/qwen3">Qwen</a><a href="/other/fake">Fake</a><a href="https://evil.test/library/fake">Fake</a>',
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", get)
    result = search_models("qwen")
    assert result == [{"value": "qwen3", "source": "https://ollama.com/library/qwen3"}]
    assert urls[0][0] == "https://ollama.com/library"
    assert urls[0][1]["params"]["q"] == "qwen"


def test_variants_are_real_local_tags(monkeypatch):
    def get(url, **kwargs):
        assert kwargs["follow_redirects"] is False
        if url == "https://ollama.com/library":
            assert kwargs["params"] == {"q": "qwen3"}
            return httpx.Response(
                200,
                text='<a href="/library/qwen3">Qwen3</a>',
                request=httpx.Request("GET", url),
            )
        assert url == "https://ollama.com/library/qwen3/tags"
        return httpx.Response(
            200,
            text='<a href="/library/qwen3:8b">8B</a><a href="/library/qwen3:8b">duplicate</a><a href="/library/qwen3:8b-cloud">cloud</a><a href="/library/other:8b">other</a>',
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", get)
    assert [m["value"] for m in search_models("qwen3:8")] == ["qwen3:8b"]


@pytest.mark.parametrize(
    "query", ["https://evil.test", "../x", "qwen3/other", "x" * 81]
)
def test_invalid_queries_never_access_network(monkeypatch, query):
    monkeypatch.setattr(httpx, "get", lambda *a, **kw: pytest.fail("network called"))
    with pytest.raises(ValueError):
        search_models(query)


def test_failure_does_not_invent_results(monkeypatch):
    monkeypatch.setattr(
        httpx,
        "get",
        lambda *a, **kw: (_ for _ in ()).throw(httpx.ConnectError("offline")),
    )
    with pytest.raises(httpx.ConnectError):
        search_models("qwen")


def test_unknown_family_never_becomes_a_request_path(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            200,
            text='<a href="/library/qwen3">Qwen3</a>',
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", get)
    assert search_models("invented:8b") == []
    assert calls == ["https://ollama.com/library"]


def test_external_library_link_cannot_authorize_a_variant_request(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        return httpx.Response(
            200,
            text='<a href="https://evil.test/library/qwen3">Qwen3</a>',
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "get", get)
    assert search_models("qwen3:8b") == []
    assert calls == ["https://ollama.com/library"]
