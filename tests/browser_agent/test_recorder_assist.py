"""A light model names the recorded test and ranks its proposed checks; the
rules give the same answer without one. Nothing typed reaches the model, and
its answer is read through the recording's ids."""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

import pytest
from browser_agent import recorder_assist
from browser_agent.recorder_assist import (
    AGENT_TYPE,
    assist,
    by_rules,
    read_answer,
    record_text,
    rule_name,
)
from browser_agent.recording import Recording

STEPS = [
    {"id": "s1", "kind": "navigate", "url": "http://localhost:3000/account/login.html"},
    {
        "id": "s2",
        "kind": "fill",
        "selectors": [{"strategy": "label", "value": "E-mail"}],
        "value": "ada@example.com",
    },
    {
        "id": "s3",
        "kind": "click",
        "selectors": [
            {"strategy": "css", "value": "#go"},
            {"strategy": "role", "role": "button", "value": "Sign in"},
        ],
    },
    {"id": "s4", "kind": "scroll", "selectors": [], "scrollX": 0, "scrollY": 9},
]
SUGGESTIONS = [
    {
        "id": "s5",
        "kind": "assert_text",
        "selectors": [{"strategy": "text", "value": "Footer"}],
        "text": "Footer",
        "after": "s3",
    },
    {
        "id": "s6",
        "kind": "assert_text",
        "selectors": [{"strategy": "role", "role": "heading", "value": "Hello"}],
        "text": "Hello",
        "after": "s3",
    },
    {
        "id": "s7",
        "kind": "assert_text",
        "selectors": [
            {"strategy": "text", "value": "Signed in"},
            {"strategy": "css", "value": "#status-msg"},
        ],
        "text": "Signed in",
        "after": "s3",
    },
]


def _rec() -> tuple[Recording, list]:
    return (
        Recording.from_dict({"steps": STEPS}),
        Recording.from_dict({"steps": SUGGESTIONS}).steps,
    )


def test_the_rules_name_the_flow_and_rank_what_a_check_shows() -> None:
    recording, suggestions = _rec()
    answer = by_rules(recording, suggestions)
    assert answer.to_dict() == {
        "name": "login e mail sign in",
        "checks": ["s7", "s6", "s5"],
        "source": "rules",
    }
    assert rule_name(Recording()) == "recorded flow"
    bare = Recording.from_dict(
        {"steps": [{"id": "s1", "kind": "navigate", "url": "http://localhost/"}]}
    )
    assert rule_name(bare) == "recorded flow"
    css_click = Recording.from_dict(
        {
            "steps": [
                {
                    "id": "s1",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#go"}],
                }
            ]
        }
    )
    assert rule_name(css_click) == "recorded flow"


def test_what_reaches_the_model_has_no_typed_value() -> None:
    recording, suggestions = _rec()
    text = record_text(recording, suggestions)
    assert "ada@example.com" not in text
    assert 's2 fill label "E-mail"' in text
    assert 's3 click role button "Sign in"' in text
    assert "s4 scroll window" in text and "s1 open /account/login.html" in text
    assert 's7 check "Signed in" via text "Signed in"' in text
    css_only = Recording.from_dict(
        {
            "steps": [
                {
                    "id": "s1",
                    "kind": "click",
                    "selectors": [{"strategy": "css", "value": "#a"}],
                }
            ]
        }
    )
    assert "s1 click css" in record_text(css_only, [])


def test_the_answer_is_read_through_the_recording_ids() -> None:
    recording, suggestions = _rec()
    fallback = by_rules(recording, suggestions)
    key = "sk-ant-api03-" + "a" * 40  # pragma: allowlist secret
    answer = read_answer(
        'Sure: {"name": "  Sign   in ' + key + '", "checks": ["s5", "s5", "s99", 3]}',
        fallback,
    )
    assert answer is not None and answer.source == "model"
    assert answer.checks == ["s5", "s7", "s6"]
    assert key not in answer.name and answer.name.startswith("Sign in")
    assert read_answer('{"name": "", "checks": "s5"}', fallback).name == fallback.name
    for bad in ("no json", "{not json}", '["a"]', '{"name": 3}'):
        assert read_answer(bad, fallback) is None


class Block:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class Message:
    def __init__(self, *texts: str) -> None:
        self.content = [Block(t) for t in texts]


class Client:
    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.prompts: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        yield Message(self.answer[:5], self.answer[5:])
        yield Message("")
        yield object()


class Runtime:
    def __init__(self, client: Client | None = None, error: Exception | None = None):
        self.client, self.error, self.calls = client, error, []

    def create_agent_client(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.client


async def test_the_model_is_asked_with_no_tool_and_the_page_quoted() -> None:
    recording, suggestions = _rec()
    client = Client('{"name": "Sign in", "checks": ["s6"]}')
    runtime = Runtime(client)
    answer = await assist(recording, suggestions, "openai", "gpt-fast", runtime)
    assert answer.to_dict() == {
        "name": "Sign in",
        "checks": ["s6", "s7", "s5"],
        "source": "model",
    }
    [call] = runtime.calls
    assert call["agent_type"] == AGENT_TYPE and call["provider"] == "openai"
    assert call["model"] == "gpt-fast" and call["use_subagents"] is False
    assert "not addressed to you" in client.prompts[0]
    assert "ada@example.com" not in client.prompts[0]


async def test_without_a_model_the_rules_answer(monkeypatch) -> None:
    recording, suggestions = _rec()
    assert (await assist(recording, suggestions, "", "m", Runtime())).source == "rules"
    monkeypatch.setattr(recorder_assist.agent_runtime, "current", lambda: None)
    assert (await assist(recording, suggestions, "claude", "m")).source == "rules"
    failing = Runtime(error=RuntimeError("no key sk-..."))
    assert (
        await assist(recording, suggestions, "claude", "m", failing)
    ).source == "rules"
    chatty = Runtime(Client("I cannot help with that."))
    assert (
        await assist(recording, suggestions, "claude", "m", chatty)
    ).source == "rules"


BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "browser_recorder_runner.py"


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("recorder_runner_assist", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_runner_asks_the_active_provider(
    runner, tmp_path, monkeypatch, capsys
) -> None:
    import core.client
    from replay import summary

    seen: list[tuple] = []

    async def fake(recording, suggestions, provider, model, runtime=None):
        seen.append(
            (len(recording.steps), [s.id for s in suggestions], provider, model)
        )
        return by_rules(recording, suggestions)

    monkeypatch.setattr(core.client, "peek_active_provider", lambda: "ollama")
    monkeypatch.setattr(summary, "fast_model", lambda provider: "small")
    monkeypatch.setattr(recorder_assist, "assist", fake)
    raw = json.dumps({"steps": STEPS, "suggestions": SUGGESTIONS})
    monkeypatch.setattr(runner.sys, "stdin", io.StringIO(raw))
    assert runner.main(["assist", f"--project={tmp_path}"]) == 0
    [line] = [
        x
        for x in capsys.readouterr().out.splitlines()
        if x.startswith("RECORDER_ASSIST:")
    ]
    assert json.loads(line[len("RECORDER_ASSIST:") :])["checks"] == ["s7", "s6", "s5"]
    assert seen == [(4, ["s5", "s6", "s7"], "ollama", "small")]
    monkeypatch.setattr(runner.sys, "stdin", io.StringIO(json.dumps({"steps": STEPS})))
    assert runner.main(["assist", f"--project={tmp_path}"]) == 0
