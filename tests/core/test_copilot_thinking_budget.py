"""Copilot sends the user's thinking budget, where `/models` says it takes one.

`capabilities/providers.yaml` declares `effort: thinking_budget` for Copilot,
and the client sent nothing. Copilot's chat completions take a
`thinking_budget` on the models whose `/models` entry gives
`capabilities.supports.max_thinking_budget`; the client reads that once per
session and keeps the budget inside the model's bounds. No network.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from core.agent_client import CopilotAgentClient

COPILOT_URL = "https://api.githubcopilot.com/chat/completions"
COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"
GITHUB_MODELS_URL = "https://models.inference.ai.azure.com/chat/completions"


class _Response:
    def __init__(self, status: int = 200, data: Any = None, body: str = ""):
        self.status = status
        self.headers: dict = {}
        self._data = data
        self._body = body

    async def json(self):
        return self._data

    async def text(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Session:
    """One scripted answer per POST (the last repeats); `/models` on GET."""

    def __init__(self, answers, models: _Response | Exception):
        self._answers = list(answers)
        self._models = models
        self.gets: list[tuple[str, dict]] = []
        self.urls: list[str] = []
        self.payloads: list[dict] = []

    def get(self, url, headers=None):
        self.gets.append((url, dict(headers or {})))
        if isinstance(self._models, Exception):
            raise self._models
        return self._models

    def post(self, url, json=None, headers=None):  # noqa: A002 - aiohttp's name
        self.urls.append(url)
        self.payloads.append(_copy(json))
        return self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]


def _copy(payload: dict) -> dict:
    return json.loads(json.dumps(payload))


def _done() -> _Response:
    return _Response(
        200, {"choices": [{"message": {"content": "Done."}, "finish_reason": "stop"}]}
    )


def _models(model: str, supports: dict, limits: dict | None = None) -> _Response:
    capabilities: dict[str, Any] = {"supports": supports}
    if limits is not None:
        capabilities["limits"] = limits
    return _Response(
        200,
        {
            "data": [
                {"id": "gpt-4o", "capabilities": {"supports": {}}},
                {"id": model, "capabilities": capabilities},
            ]
        },
    )


def _client(answers, models, *, model="claude-sonnet-4.5", thinking_budget=16384):
    client = CopilotAgentClient(
        model=model,
        github_token="ghp_test",
        system_prompt="be brief",
        thinking_budget=thinking_budget,
    )
    client._get_copilot_token = AsyncMock(return_value="copilot-token")
    session = _Session(answers, models)
    client._http_client = session
    return client, session


async def _run(client) -> None:
    await client.query("fix it")
    async for _ in client.receive_response():
        pass


THINKING = {"min_thinking_budget": 1024, "max_thinking_budget": 32000}


@pytest.mark.asyncio
async def test_the_users_budget_reaches_a_model_that_takes_one():
    client, session = _client([_done()], _models("claude-sonnet-4.5", THINKING))

    await _run(client)

    assert session.payloads[0]["thinking_budget"] == 16384
    url, headers = session.gets[0]
    assert url == COPILOT_MODELS_URL
    assert headers["Authorization"] == "Bearer copilot-token"


@pytest.mark.asyncio
async def test_the_budget_is_read_once_per_response_and_sent_on_every_turn():
    tool_call = {
        "id": "call_1",
        "function": {"name": "read_file", "arguments": '{"path": "a.py"}'},
    }
    turn = _Response(
        200,
        {
            "choices": [
                {
                    "message": {"content": "", "tool_calls": [tool_call]},
                    "finish_reason": "tool_calls",
                }
            ]
        },
    )
    client, session = _client([turn, _done()], _models("claude-sonnet-4.5", THINKING))
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._tool_executor = AsyncMock()
    client._tool_executor.execute = AsyncMock(return_value="x = 1\n")

    await _run(client)

    assert len(session.gets) == 1
    assert [p["thinking_budget"] for p in session.payloads] == [16384, 16384]


@pytest.mark.asyncio
async def test_the_budget_stays_inside_the_models_bounds():
    client, session = _client(
        [_done()],
        _models("claude-sonnet-4.5", THINKING),
        thinking_budget=63999,  # ultrathink
    )

    await _run(client)

    assert session.payloads[0]["thinking_budget"] == 32000


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "models",
    [
        _models("claude-sonnet-4.5", {}),  # takes no budget
        _models("another-model", THINKING),  # not listed
        _Response(500, body="down"),
        OSError("unreachable"),
    ],
)
async def test_nothing_is_sent_when_the_model_takes_no_budget_or_models_fails(
    models,
):
    client, session = _client([_done()], models)

    await _run(client)

    assert "thinking_budget" not in session.payloads[0]
    assert session.urls == [COPILOT_URL]


@pytest.mark.asyncio
async def test_no_lookup_without_a_budget():
    client, session = _client(
        [_done()], _models("claude-sonnet-4.5", THINKING), thinking_budget=None
    )

    await _run(client)

    assert session.gets == []
    assert "thinking_budget" not in session.payloads[0]


@pytest.mark.asyncio
async def test_github_models_gets_no_copilot_field():
    client, session = _client(
        [_Response(403, body="blocked"), _done()],
        _models("claude-sonnet-4.5", THINKING),
    )

    await _run(client)

    assert session.urls == [COPILOT_URL, GITHUB_MODELS_URL]
    assert session.payloads[0]["thinking_budget"] == 16384
    assert "thinking_budget" not in session.payloads[1]


@pytest.mark.asyncio
async def test_a_model_swap_drops_the_old_models_budget():
    client, session = _client(
        [_Response(400, body='{"error": {"code": "model_not_supported"}}'), _done()],
        _models("claude-opus-4.8", THINKING),
        model="claude-opus-4.8",
    )

    await _run(client)

    assert session.payloads[0]["thinking_budget"] == 16384
    assert session.payloads[1]["model"] != "claude-opus-4.8"
    assert "thinking_budget" not in session.payloads[1]
