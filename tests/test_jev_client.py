"""Bounded TypeSafe HTTP, including malicious/partial responses."""

import asyncio
import json

import httpx
import pytest
from integrations.jev.client import JevClient, JevRequestError


@pytest.mark.asyncio
async def test_endpoint_bearer_and_payload():
    def respond(request):
        assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["authorization"] == "Bearer test-key"
        assert json.loads(request.content)["model"] == "jev-latest"
        return httpx.Response(
            200, json={"model": "jev-test", "answers": {}, "usage": {}}
        )

    result = await JevClient(httpx.MockTransport(respond)).post(
        key="test-key", payload={"model": "jev-latest"}, timeout_seconds=1
    )
    assert result["model"] == "jev-test"


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        (401, "unauthorized"),
        (403, "unauthorized"),
        (429, "rate_limited"),
        (500, "unavailable"),
        (302, "unavailable"),
    ],
)
@pytest.mark.asyncio
async def test_no_retry_or_redirect(status, reason):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(
            status,
            headers={"location": "https://other.invalid"},
            text="private server error",
        )

    with pytest.raises(JevRequestError) as error:
        await JevClient(httpx.MockTransport(respond)).post(
            key="test-key", payload={}, timeout_seconds=1
        )
    assert error.value.reason == reason
    assert len(calls) == 1
    assert "test-key" not in str(error.value)
    assert "private" not in str(error.value)


@pytest.mark.parametrize(
    "body",
    [b"not-json", b"[]", b'{"x":NaN}', b"x" * (256 * 1024 + 1)],
    ids=["text", "array", "nan", "oversized"],
)
@pytest.mark.asyncio
async def test_invalid_or_oversized_body(body):
    with pytest.raises(JevRequestError, match="invalid_response"):
        await JevClient(
            httpx.MockTransport(lambda _: httpx.Response(200, content=body))
        ).post(key="k", payload={}, timeout_seconds=1)


@pytest.mark.asyncio
async def test_whole_operation_deadline():
    async def respond(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    with pytest.raises(JevRequestError, match="timeout"):
        await JevClient(httpx.MockTransport(respond)).post(
            key="k", payload={}, timeout_seconds=0.01
        )
