"""A sign-in refusal answered as a message is an authentication error.

The Claude CLI answers an expired or revoked OAuth token with an assistant
message ("Failed to authenticate. API Error: 401 …"), not an exception. The
session loop returned ``continue`` with it, the planner's validation read it as
a plan without ``phases``, and after three of them the task failed with "the
model did not produce a valid implementation_plan.json" — on an account
problem. Both session runners now return the ``authentication`` error the
exception path returns, which pauses the task for a new sign-in and starts the
automatic failover.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from agents.session import _entry_is_useful_for_replay, _run_agent_client_session
from agents.session_signals import auth_failure_in_turn, is_auth_failure_echo
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from task_logger import LogPhase

CLI_REFUSAL = (
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":'
    '"authentication_error","message":"OAuth access token has expired. '
    'Re-authenticate to continue."},"request_id":"req_0000"}'
)


class _FakeClient:
    def __init__(self, messages: list[AgentMessage]):
        self.model = "claude-haiku-5-5"
        self._messages = messages
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None

    def provider_name(self) -> str:
        return "copilot"

    async def query(self, prompt: str) -> None:  # noqa: ARG002 - fake
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for m in self._messages:
            yield m


def _text(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role, content=[ContentBlock(type=ContentBlockType.TEXT, text=text)]
    )


async def _run(spec_dir: Path, messages: list[AgentMessage]):
    return await _run_agent_client_session(
        _FakeClient(messages),
        "plan it",
        spec_dir,
        verbose=False,
        phase=LogPhase.PLANNING,
    )


@pytest.mark.parametrize(
    "text",
    [
        CLI_REFUSAL,
        "Invalid API key · Please run /login",
        "OAuth token has expired. Please obtain a new token or refresh your existing token.",
        "OAuth token revoked · Please run /login",
        "API Error: 401 Unauthorized",
        "  Please run /login  ",
    ],
)
def test_the_cli_refusals_are_recognised(text: str) -> None:
    assert is_auth_failure_echo(text)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "Fixed the Invalid API key message on the login page.",
        "I created implementation_plan.json with 2 phases.",
        "Handled HTTP 401 in the client: it now asks to sign in again.",
        # A long answer that starts like one is prose, not a refusal.
        "Failed to authenticate users is the bug. " + "Details. " * 80,
    ],
)
def test_model_prose_is_not_a_refusal(text: str) -> None:
    assert not is_auth_failure_echo(text)


def test_status_lines_count_only_for_a_turn_without_an_answer() -> None:
    status = "Copilot API error (401): Unauthorized\n"
    assert auth_failure_in_turn("", status) == "Copilot API error (401): Unauthorized"
    # Beside real work it is a notice, and the turn stands.
    assert auth_failure_in_turn("I wrote the plan.", status) is None
    # A heartbeat counting 401 tokens is not an error line.
    assert auth_failure_in_turn("", "⏳ generating: 401 tokens in 30 s") is None


@pytest.mark.asyncio
async def test_a_refusal_answered_as_text_is_an_authentication_error(
    tmp_path: Path,
) -> None:
    status, response, info = await _run(
        tmp_path, [_text(MessageRole.ASSISTANT, CLI_REFUSAL)]
    )

    assert status == "error"
    assert info["type"] == "authentication"
    assert response == CLI_REFUSAL


@pytest.mark.asyncio
async def test_a_refusal_reported_as_the_only_status_is_an_authentication_error(
    tmp_path: Path,
) -> None:
    status, _response, info = await _run(
        tmp_path, [_text(MessageRole.SYSTEM, "OpenAI API error (401): invalid_api_key")]
    )

    assert status == "error"
    assert info["type"] == "authentication"


@pytest.mark.asyncio
async def test_a_turn_that_mentions_a_401_is_still_a_turn(tmp_path: Path) -> None:
    status, response, _info = await _run(
        tmp_path,
        [_text(MessageRole.ASSISTANT, "Handled HTTP 401 in the client.")],
    )

    assert status == "continue"
    assert response == "Handled HTTP 401 in the client."


def _entry(role: str, text: str) -> dict:
    return {"role": role, "content": [{"type": "text", "text": text}]}


def test_a_refusal_is_not_replayed_as_context() -> None:
    assert not _entry_is_useful_for_replay(_entry("assistant", CLI_REFUSAL))
    assert _entry_is_useful_for_replay(_entry("assistant", "I wrote the plan."))


def test_an_earlier_session_prompt_is_not_replayed_behind_the_effort_line() -> None:
    """The engine puts "EFFORT: …" before the worktree preamble. A startswith
    missed it, so each retry replayed every earlier planner prompt and the
    replay grew by a whole prompt per attempt (5 k → 168 k characters)."""
    prompt = (
        "EFFORT: medium\nWORKFLOW PHASE: planning\n\n"
        "## ⛔ ISOLATED WORKTREE - CRITICAL\n\nYou are in a worktree. " + "x" * 30_000
    )
    assert not _entry_is_useful_for_replay(_entry("user", prompt))
    # A user turn that only quotes the marker far down is kept.
    note = "Please also look at this.\n" + "y" * 5_000 + "⛔ ISOLATED WORKTREE"
    assert _entry_is_useful_for_replay(_entry("user", note))


def test_the_planning_failure_quotes_a_short_answer() -> None:
    from spec.plan_recovery import invalid_plan_message

    message = invalid_plan_message("", "model_not_available_for_integrator: claude-x")
    assert message.startswith("Planning failed: the model did not produce a valid")
    assert "«model_not_available_for_integrator: claude-x»" in message
    # A long answer (a plan written as prose) is not pasted onto the card.
    assert "«" not in invalid_plan_message("", "word " * 200)
    assert invalid_plan_message(" hint.", None).endswith("`phases`). hint.")
