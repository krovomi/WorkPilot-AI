"""Each vision call keeps the tokens its provider reported, for the loop's budget."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from design_to_code.budget import Usage
from services.design_to_code_service import DesignToCodeService

IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
KEY = "sk-test-0000"  # pragma: allowlist secret


@pytest.fixture
def network(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    sent: list[httpx.Request] = []
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        host = request.url.host
        if host == "api.anthropic.com":
            return httpx.Response(
                200,
                json={
                    "content": [{"text": "claude"}],
                    "usage": {"input_tokens": 11, "output_tokens": 2},
                },
            )
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(
                200,
                json={
                    "candidates": [{"content": {"parts": [{"text": "gemini"}]}}],
                    "usageMetadata": {
                        "promptTokenCount": 7,
                        "candidatesTokenCount": 3,
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "openai"}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 4},
            },
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k),
    )
    return sent


@pytest.fixture
def service(tmp_path: Path) -> DesignToCodeService:
    return DesignToCodeService(str(tmp_path))


async def test_claude_openai_and_gemini_record_their_usage(service, network) -> None:
    assert service.last_usage is None
    assert await service._call_claude_vision(KEY, IMAGE, "p") == "claude"
    assert service.last_usage == Usage(11, 2)
    assert await service._call_openai_vision(KEY, IMAGE, "p") == "openai"
    assert service.last_usage == Usage(5, 4)
    assert network[-1].read() and b'"gpt-4o"' in network[-1].content
    assert await service._call_gemini_vision(KEY, IMAGE, "p") == "gemini"
    assert service.last_usage == Usage(7, 3)
    assert "gemini-1.5-flash" in str(network[-1].url)


class _Client:
    """The SDK client: an answer, then the closing result with its usage."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        async for _ in prompt:
            pass

    async def receive_response(self):
        yield SimpleNamespace(content=[SimpleNamespace(text="seen")])
        yield SimpleNamespace(
            total_cost_usd=0.01, usage={"input_tokens": 9, "output_tokens": 1}
        )


async def test_the_subscription_records_the_usage_of_its_result(
    service, monkeypatch
) -> None:
    monkeypatch.setattr(
        "core.simple_client.create_simple_client", lambda **kwargs: _Client()
    )
    assert await service._call_claude_subscription_vision(IMAGE, "p") == "seen"
    assert service.last_usage == Usage(9, 1)
