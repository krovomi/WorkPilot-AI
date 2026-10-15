"""harness.application.budget and the session runner: one cap for every client."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from harness.application import budget as budget_module
from harness.application.budget import (
    BUDGET_ENV,
    DEFAULT_BUDGET_USD,
    budget_for,
    prices_for,
    session_budget_usd,
)
from harness.domain import CallUsage, TokenPrices, UsageLedger
from task_logger import LogPhase


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, DEFAULT_BUDGET_USD),
        ("", DEFAULT_BUDGET_USD),
        ("12.5", 12.5),
        # 0 or less switches the cap off.
        ("0", None),
        ("-1", None),
        # Unreadable: the default, not "uncapped".
        ("five", DEFAULT_BUDGET_USD),
        ("inf", DEFAULT_BUDGET_USD),
        ("nan", DEFAULT_BUDGET_USD),
    ],
)
def test_session_budget_usd(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv(BUDGET_ENV, raising=False)
    else:
        monkeypatch.setenv(BUDGET_ENV, raw)
    assert session_budget_usd() == expected


@pytest.mark.parametrize(
    ("provider", "model", "priced"),
    [
        ("openai", "gpt-4o", True),
        # Client names the catalog files under another provider name.
        ("claude", "claude-opus-4-8", True),
        ("openai-codex-cli", "gpt-5", True),
        # OpenCode names the vendor in the model.
        ("opencode", "openai/gpt-5", True),
        ("openai", "a-model-nobody-prices", False),
        (None, "gpt-4o", False),
        ("openai", None, False),
    ],
)
def test_prices_for(provider, model, priced):
    assert (prices_for(provider, model) is not None) is priced


class _Client:
    def __init__(self, *, own_budget=False, provider="openai", model="gpt-4o"):
        self.enforces_own_budget = own_budget
        self._provider = provider
        self.model = model

    def provider_name(self):
        return self._provider


def test_a_client_that_caps_itself_gets_no_second_cap(monkeypatch):
    monkeypatch.delenv(BUDGET_ENV, raising=False)
    assert budget_for(_Client(own_budget=True)) is None
    assert budget_for(_Client()).cap_usd == DEFAULT_BUDGET_USD


def test_switching_the_cap_off_removes_it(monkeypatch):
    monkeypatch.setenv(BUDGET_ENV, "0")
    assert budget_for(_Client()) is None


def test_the_claude_wrapper_declares_its_own_cap():
    from core.agent_client import ClaudeAgentClient, OpenAIAgentClient

    assert ClaudeAgentClient.enforces_own_budget is True
    assert OpenAIAgentClient.enforces_own_budget is False


# --- the session runner ------------------------------------------------------

# $1 per million input tokens, nothing else: a 100 000-token call costs $0.10.
_PRICES = TokenPrices(input=1.0, output=0.0)


class _SpendingClient:
    """Each response message follows one 100 000-token call."""

    enforces_own_budget = False

    def __init__(self, calls: int) -> None:
        self.model = "some-model"
        self.last_usage = None
        self.last_context_tokens = None
        self.context_window_tokens = 1_000_000
        self.usage_ledger = UsageLedger()
        self._calls = calls
        self.yielded = 0

    def provider_name(self) -> str:
        return "deepseek"

    def resumes_native_session(self) -> bool:
        return False

    async def resume(self, history) -> None:  # noqa: ARG002
        return None

    async def query(self, prompt: str) -> None:  # noqa: ARG002
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for index in range(self._calls):
            self.usage_ledger.record(CallUsage(100_000, None, None, 10))
            self.yielded += 1
            yield AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text=f"step {index}")
                ],
            )


def _spec(tmp_path: Path) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    (spec / "task_metadata.json").write_text(
        json.dumps({"taskId": "t1"}), encoding="utf-8"
    )
    return spec


@pytest.mark.asyncio
async def test_the_session_stops_at_the_cap(tmp_path, monkeypatch, capsys):
    from agents.session import _run_agent_client_session

    monkeypatch.setenv(BUDGET_ENV, "0.25")
    monkeypatch.setattr(budget_module, "prices_for", lambda *_: _PRICES)
    client = _SpendingClient(calls=10)

    status, _text, info = await _run_agent_client_session(
        client, "code it", _spec(tmp_path), phase=LogPhase.CODING
    )

    # $0.10 per call: the third call reaches $0.30, past the $0.25 cap.
    assert client.yielded == 3
    assert status == "continue"
    assert info == {"budget_exceeded": True, "spent_usd": pytest.approx(0.3)}
    assert "Session budget reached" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_a_session_under_the_cap_runs_to_its_end(tmp_path, monkeypatch):
    from agents.session import _run_agent_client_session

    monkeypatch.setenv(BUDGET_ENV, "5")
    monkeypatch.setattr(budget_module, "prices_for", lambda *_: _PRICES)
    client = _SpendingClient(calls=4)

    status, _text, info = await _run_agent_client_session(
        client, "code it", _spec(tmp_path), phase=LogPhase.CODING
    )

    assert client.yielded == 4
    assert (status, info) == ("continue", {})


@pytest.mark.asyncio
async def test_an_unpriced_model_runs_uncapped_and_says_so_once(
    tmp_path, monkeypatch, capsys
):
    from agents import session

    monkeypatch.setenv(BUDGET_ENV, "0.01")
    monkeypatch.setattr(budget_module, "prices_for", lambda *_: None)
    monkeypatch.setattr(session, "_UNPRICED_REPORTED", set())

    for _ in range(2):
        client = _SpendingClient(calls=3)
        await session._run_agent_client_session(
            client, "code it", _spec(tmp_path / str(id(client))), phase=LogPhase.CODING
        )
        assert client.yielded == 3

    assert capsys.readouterr().out.count("No price known") == 1
