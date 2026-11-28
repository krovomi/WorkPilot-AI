"""Each vision call keeps the tokens its provider reported, for the loop's budget,
and answers in the edits' schema when the loop forces it."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from design_to_code.budget import Usage
from design_to_code.feedback import parse_answer
from services import design_to_code_edit_calls as calls
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


EDITS = {"edits": [{"path": "index.html", "find": "a", "replace": "b"}], "notes": []}


@pytest.fixture
def forced_network(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Each provider answers the forced call in its own shape."""
    bodies: list[dict] = []
    real = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.read()))
        host = request.url.host
        if host == "api.anthropic.com":
            return httpx.Response(
                200,
                json={
                    "content": [
                        {"type": "text", "text": "Here are the edits."},
                        {"type": "tool_use", "name": "submit_edits", "input": EDITS},
                    ],
                    "usage": {"input_tokens": 11, "output_tokens": 2},
                },
            )
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(
                200,
                json={
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {
                                        "functionCall": {
                                            "name": "submit_edits",
                                            "args": EDITS,
                                        }
                                    }
                                ]
                            }
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 7,
                        "candidatesTokenCount": 3,
                    },
                },
            )
        if host == "api.openai.com":
            call = {
                "function": {"name": "submit_edits", "arguments": json.dumps(EDITS)}
            }
            message = {"content": None, "tool_calls": [call]}
        else:  # a local server constrained by response_format
            message = {"content": json.dumps(EDITS)}
        return httpx.Response(
            200,
            json={
                "choices": [{"message": message}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 4},
            },
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k),
    )
    return bodies


async def test_claude_is_made_to_call_the_edits_tool(service, forced_network) -> None:
    answer = await service._call_claude_vision(KEY, IMAGE, "p", forced=True)
    assert parse_answer(answer) == parse_answer(json.dumps(EDITS))
    assert json.loads(answer) == EDITS and service.last_usage == Usage(11, 2)
    body = forced_network[-1]
    assert body["tool_choice"] == {"type": "tool", "name": "submit_edits"}
    assert body["tools"][0]["input_schema"] == calls.EDITS_SCHEMA


async def test_openai_is_made_to_call_the_edits_function(
    service, forced_network
) -> None:
    answer = await service._call_openai_vision(KEY, IMAGE, "p", forced=True)
    assert json.loads(answer) == EDITS and service.last_usage == Usage(5, 4)
    body = forced_network[-1]
    assert body["tool_choice"] == {
        "type": "function",
        "function": {"name": "submit_edits"},
    }
    assert body["tools"][0]["function"]["parameters"] == calls.EDITS_SCHEMA


async def test_gemini_is_made_to_call_the_edits_function(
    service, forced_network
) -> None:
    answer = await service._call_gemini_vision(KEY, IMAGE, "p", forced=True)
    assert json.loads(answer) == EDITS and service.last_usage == Usage(7, 3)
    body = forced_network[-1]
    assert body["toolConfig"] == {
        "functionCallingConfig": {
            "mode": "ANY",
            "allowedFunctionNames": ["submit_edits"],
        }
    }
    parameters = body["tools"][0]["functionDeclarations"][0]["parameters"]
    assert parameters["type"] == "OBJECT"
    assert parameters["properties"]["edits"]["items"]["type"] == "OBJECT"
    assert parameters["required"] == ["edits"]


@pytest.mark.parametrize("provider", ["lm-studio", "llama-cpp", "ollama"])
async def test_a_local_server_answers_in_the_schema(
    service, forced_network, monkeypatch, provider
) -> None:
    monkeypatch.setattr("core.oneshot._resolve_model", lambda *a: "local-model")
    answer = await service._call_local_vision(provider, IMAGE, "p", forced=True)
    assert json.loads(answer) == EDITS
    assert forced_network[-1]["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "submit_edits", "schema": calls.EDITS_SCHEMA},
    }


async def test_without_forced_no_tool_is_offered(
    service, forced_network, monkeypatch
) -> None:
    monkeypatch.setattr("core.oneshot._resolve_model", lambda *a: "local-model")
    await service._call_local_vision("lm-studio", IMAGE, "p")
    await service._call_claude_vision(KEY, IMAGE, "p")
    assert all(
        "tools" not in body and "response_format" not in body for body in forced_network
    )
