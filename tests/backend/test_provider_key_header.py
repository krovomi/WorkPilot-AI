"""Provider key checks send each key the way its provider reads it."""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from apps.backend import provider_api


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    requests: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": []})

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(answer)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(provider_api.httpx, "AsyncClient", client)
    monkeypatch.setattr(provider_api, "set_validated", lambda *a, **k: None)
    return requests


@pytest.mark.parametrize(
    ("provider", "header", "value"),
    [
        ("google", "x-goog-api-key", "g-key-0000"),
        ("anthropic", "x-api-key", "sk-ant-0000"),
        ("openai", "authorization", "Bearer sk-0000"),
    ],
)
async def test_the_key_travels_in_its_header_and_never_in_the_url(
    sent: list[httpx.Request], provider: str, header: str, value: str
) -> None:
    key = value.removeprefix("Bearer ")
    spec = provider_api._VALIDATION_SPECS[provider]

    await provider_api._validate_key_http(provider, key, spec)

    [request] = sent
    assert request.headers[header] == value
    assert key not in str(request.url)
    assert not request.url.params


async def test_a_refused_google_key_is_reported_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_client = httpx.AsyncClient
    marked: list[bool] = []

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(lambda r: httpx.Response(401))
        return real_client(*args, **kwargs)

    monkeypatch.setattr(provider_api.httpx, "AsyncClient", client)
    monkeypatch.setattr(
        provider_api, "set_validated", lambda p, k, ok: marked.append(ok)
    )

    with pytest.raises(HTTPException):
        await provider_api._validate_key_http(
            "google", "g-key-0000", provider_api._VALIDATION_SPECS["google"]
        )
    assert marked == [False]
