"""An API failure the Claude CLI reports as a message is a failure, not an answer.

The CLI does not raise when the model id is wrong: it emits an assistant
message of its own — "There's an issue with the selected model (gemma4:12b).
It may not exist or you may not have access to it." — tagged ``error:
"model_not_found"``. ``oneshot_completion`` used to read that sentence as the
completion, so the prompt optimizer displayed it as the optimized prompt, with
"no changes needed" underneath.
"""

import asyncio
import sys
from dataclasses import dataclass, field
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))


@dataclass
class TextBlock:
    text: str


@dataclass
class AssistantMessage:
    """Named like the SDK's: ``oneshot`` recognises it by type name."""

    content: list = field(default_factory=list)
    error: str | None = None


class FakeClient:
    """Yields the SDK messages it is given, wrapped like ``ClaudeAgentClient``."""

    def __init__(self, *raw_messages):
        self._raw = raw_messages
        self.last_usage = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        return None

    async def receive_response(self):
        from core.agent_client import ClaudeAgentClient

        wrapper = ClaudeAgentClient.__new__(ClaudeAgentClient)
        for raw in self._raw:
            yield wrapper._wrap_sdk_message(raw)


def run(monkeypatch, client, **kwargs):
    from core import oneshot

    monkeypatch.setattr(oneshot, "_build_client", lambda *a, **k: client)
    return asyncio.run(
        oneshot.oneshot_completion(
            "hello", provider="claude", model="gemma4:12b-it-q4_K_M", **kwargs
        )
    )


MODEL_ERROR = (
    "There's an issue with the selected model (gemma4:12b-it-q4_K_M). "
    "It may not exist or you may not have access to it."
)


def test_the_error_message_is_not_returned_as_the_completion(monkeypatch):
    client = FakeClient(
        AssistantMessage([TextBlock(MODEL_ERROR)], error="model_not_found")
    )
    deltas, errors = [], []

    text = run(monkeypatch, client, on_delta=deltas.append, on_error=errors.append)

    assert text == ""
    assert deltas == []  # nothing streamed into the result panel either
    assert errors and errors[0]["code"] == "model_unavailable"
    assert "issue with the selected model" in errors[0]["message"]
    assert errors[0]["model"] == "gemma4:12b-it-q4_K_M"


def test_each_sdk_error_kind_keeps_its_own_code(monkeypatch):
    expected = {
        "authentication_failed": "auth",
        "billing_error": "quota",
        "rate_limit": "rate_limit",
        "server_error": "provider_unavailable",
    }
    for kind, code in expected.items():
        errors = []
        client = FakeClient(AssistantMessage([TextBlock("API Error")], error=kind))

        assert run(monkeypatch, client, on_error=errors.append) == ""
        assert errors[0]["code"] == code, kind


def test_an_ordinary_answer_is_untouched(monkeypatch):
    client = FakeClient(AssistantMessage([TextBlock("<optimized>ok</optimized>")]))

    assert run(monkeypatch, client) == "<optimized>ok</optimized>"


def test_classify_names_an_unknown_model_whichever_provider_said_it():
    from foundation.error_details import MODEL_UNAVAILABLE, classify

    assert classify(MODEL_ERROR) == MODEL_UNAVAILABLE
    # OpenAI's 404 body, and Ollama's.
    assert (
        classify("NotFoundError", "Error code: 404 - {'code': 'model_not_found'}")
        == MODEL_UNAVAILABLE
    )
    assert (
        classify('model "gemma4:12b" not found, try pulling it first')
        == MODEL_UNAVAILABLE
    )


def test_the_claude_client_applies_the_chosen_effort(monkeypatch):
    # "none" must reach the SDK as 0: None would mean "the agent type's
    # default", and a page set to no thinking would think anyway.
    from core import oneshot, simple_client

    budgets = []

    def fake_create_simple_client(**kwargs):
        budgets.append(kwargs.get("max_thinking_tokens"))
        return object()

    monkeypatch.setattr(
        simple_client, "create_simple_client", fake_create_simple_client
    )

    for level in (None, "none", "high"):
        oneshot._claude_client("claude-sonnet-5", None, None, level)

    from phase_config import get_thinking_budget

    assert budgets == [None, 0, get_thinking_budget("high")]


class NoticeClient:
    """Yields ``AgentMessage``s as a streaming client (Copilot, OpenAI…) does."""

    def __init__(self, *messages):
        self._messages = messages
        self.last_usage = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        return None

    async def receive_response(self):
        for message in self._messages:
            yield message


def _message(role_name: str, text: str):
    from core.agent_client import (
        AgentMessage,
        ContentBlock,
        ContentBlockType,
        MessageRole,
    )

    return AgentMessage(
        role=getattr(MessageRole, role_name),
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


COPILOT_AUTH_ERROR = (
    "Copilot auth error: Copilot token exchange failed (403): 403 Forbidden."
)


def test_a_client_notice_is_a_failure_not_the_answer(monkeypatch):
    """The Arena offered "Copilot auth error: …" as Copilot's answer to vote for."""
    client = NoticeClient(_message("SYSTEM", COPILOT_AUTH_ERROR))
    deltas, errors = [], []

    text = run(monkeypatch, client, on_delta=deltas.append, on_error=errors.append)

    assert text == ""
    assert deltas == []
    assert errors and "Copilot auth error" in errors[0]["message"]
    assert errors[0]["code"] == "auth"


def test_a_notice_beside_a_real_answer_stays_out_of_it(monkeypatch):
    client = NoticeClient(
        _message("SYSTEM", "⚠️ the model refused the effort setting"),
        _message("ASSISTANT", "Hello!"),
    )
    deltas, errors = [], []

    text = run(monkeypatch, client, on_delta=deltas.append, on_error=errors.append)

    assert text == "Hello!"
    assert deltas == ["Hello!"]
    assert errors == []


def test_a_comparison_keeps_copilot_on_the_model_it_named(monkeypatch):
    """`require_provider` (the Arena) also forbids Copilot's model swap."""
    import core.agent_client as agent_client
    from core import oneshot

    built = []

    class Recorder:
        def __init__(self, **kwargs):
            built.append(kwargs)

    monkeypatch.setattr(agent_client, "CopilotAgentClient", Recorder)
    for require in (True, False):
        oneshot._build_client(
            "copilot",
            "claude-opus-4.8",
            None,
            None,
            None,
            1,
            chosen=True,
            exact_model=require,
        )

    assert [kw["allow_model_fallback"] for kw in built] == [False, True]
