"""A client's own status lines are not the model's answer.

Every ``MessageRole.SYSTEM`` message an AgentClient yields is something the
client says about itself — a generation heartbeat, model-pull progress, an API
error — never model output. The session loop used to fold them into
``response_text``, write them to the conversation log, and stream them as
"agent thinking", which on a slow local model meant:

* the phase's answer was prefixed with "⏳ generating for 30 s…";
* the short-response error classifiers, gated at 80 / 200 characters, stopped
  firing, so a provider error ended the stream as an ordinary "continue" and
  the caller retried the same failing prompt;
* the log replayed on the next session was mostly heartbeats — and since
  ``LocalAgentClient.resume`` keeps the NEWEST messages to fit an 8k window,
  they were exactly what survived.

These tests pin each of those down.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from task_logger import LogPhase


class _FakeClient:
    """Bare AgentClient stand-in: yields a fixed set of messages."""

    def __init__(self, messages: list[AgentMessage]):
        self.model = "llama3.3"
        self._messages = messages
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None

    def provider_name(self) -> str:
        return "ollama"

    async def query(self, prompt: str) -> None:  # noqa: ARG002 - fake
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for m in self._messages:
            yield m


def _text(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role, content=[ContentBlock(type=ContentBlockType.TEXT, text=text)]
    )


HEARTBEAT = (
    "⏳ tour 3/50 — « llama3.3 » génère : 412 tokens en 1 min 30 s (~4,6 tok/s)."
)


async def _run(spec_dir: Path, messages: list[AgentMessage]):
    from agents.session import _run_agent_client_session

    return await _run_agent_client_session(
        _FakeClient(messages),
        "implement the thing",
        spec_dir,
        verbose=False,
        phase=LogPhase.CODING,
    )


@pytest.mark.asyncio
async def test_status_lines_stay_out_of_the_response(tmp_path: Path) -> None:
    status, response, _info = await _run(
        tmp_path,
        [
            _text(MessageRole.SYSTEM, HEARTBEAT),
            _text(MessageRole.ASSISTANT, "I edited main.py."),
            _text(MessageRole.SYSTEM, HEARTBEAT),
        ],
    )

    assert status == "continue"
    assert response == "I edited main.py."


@pytest.mark.asyncio
async def test_status_lines_are_not_replayed_as_context(tmp_path: Path) -> None:
    from core.conversation_log import read_log

    await _run(
        tmp_path,
        [
            _text(MessageRole.SYSTEM, HEARTBEAT),
            _text(MessageRole.ASSISTANT, "I edited main.py."),
        ],
    )

    entries = read_log(tmp_path, "ollama", "llama3.3")
    logged = [
        block.get("text", "")
        for entry in entries
        for block in (entry.get("content") or [])
    ]
    assert any("I edited main.py." in text for text in logged)
    assert not any("génère" in text for text in logged)


@pytest.mark.asyncio
async def test_a_turn_of_pure_status_still_reports_what_happened(
    tmp_path: Path,
) -> None:
    """An error the classifiers do not recognise must not read as a silent
    successful turn — the caller needs something to show and to log."""
    status, response, _info = await _run(
        tmp_path, [_text(MessageRole.SYSTEM, "Ollama API error (500): runner crashed")]
    )

    assert status == "continue"
    assert "runner crashed" in response


@pytest.mark.asyncio
async def test_blown_local_context_halts_instead_of_looping(tmp_path: Path) -> None:
    """Ollama reports an overflowed num_ctx as an API error whose body is far
    longer than the 80-character gate on the response-text classifier. Before
    this was read as a status line, the phase returned "continue" and the caller
    sent the same oversized prompt again, forever."""
    status, _response, info = await _run(
        tmp_path,
        [
            _text(MessageRole.SYSTEM, HEARTBEAT),
            _text(
                MessageRole.SYSTEM,
                'Ollama API error (400): {"error":"request exceeds the available '
                'context size (4096 tokens); try increasing num_ctx"}',
            ),
        ],
    )

    assert status == "error"
    assert info["type"] == "prompt_too_long"


class TestPromptTooLongPatterns:
    """The classifier has to know the wording each provider actually uses."""

    @pytest.mark.parametrize(
        "message",
        [
            "request exceeds the available context size (4096 tokens)",
            "This model's maximum context length is 8192 tokens",
            "Prompt is too long: 250000 tokens",
            "input exceeds context length",
        ],
    )
    def test_recognised(self, message: str) -> None:
        from agents.session import is_prompt_too_long_error

        assert is_prompt_too_long_error(RuntimeError(message))

    @pytest.mark.parametrize(
        "message",
        [
            "connection refused",
            "model not found, try pulling it first",
            "tool execution failed: file not found",
        ],
    )
    def test_not_over_matched(self, message: str) -> None:
        from agents.session import is_prompt_too_long_error

        assert not is_prompt_too_long_error(RuntimeError(message))
