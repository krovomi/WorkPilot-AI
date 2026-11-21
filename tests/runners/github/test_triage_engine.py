"""Issue triage: a model reads an issue and its look-alikes and classifies it.

`TriageEngine.triage_single_issue` (runners/github/services/triage_engine.py)
builds the issue's context (its body and the open issues with similar titles),
sends it with the triage prompt and reads the model's answer into a
`TriageResult`: bug, feature, duplicate of #N, spam... The model is a stand-in
`create_agent_client` that answers with the provider-neutral messages every
agent client yields.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from runners.github.models import GitHubRunnerConfig, TriageCategory
from runners.github.services.triage_engine import TriageEngine

ISSUE = {
    "number": 4,
    "title": "Login fails on Safari",
    "author": {"login": "ann"},
    "createdAt": "2026-11-01T00:00:00Z",
    "labels": [{"name": "bug"}, {"name": "web"}],
    "body": "Clicking Sign in does nothing.",
}
OTHERS = [
    ISSUE,
    {"number": 2, "title": "Login fails on Firefox"},
    {"number": 3, "title": "Add dark mode"},
]


class FakeClient:
    """Records the prompt and answers with the messages it was given."""

    def __init__(self, messages, **options):
        self.messages = messages
        self.options = options
        self.prompts: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        for message in self.messages:
            if isinstance(message, BaseException):
                raise message
            yield message


def text(role: MessageRole, value: str) -> AgentMessage:
    return AgentMessage(
        role=role, content=[ContentBlock(type=ContentBlockType.TEXT, text=value)]
    )


@pytest.fixture
def model(monkeypatch):
    """The stand-in model; `answer(...)` sets what it says next."""
    made: list[FakeClient] = []
    replies: list = []

    def create_agent_client(**options):
        client = FakeClient(list(replies), **options)
        made.append(client)
        return client

    monkeypatch.setattr(
        importlib.import_module("core.client"),
        "create_agent_client",
        create_agent_client,
    )

    def answer(*messages):
        replies[:] = messages
        return made

    return answer


@pytest.fixture
def engine(tmp_path):
    return TriageEngine(
        project_dir=tmp_path,
        github_dir=tmp_path / ".workpilot" / "github",
        config=GitHubRunnerConfig(token="t", repo="own/repo", model="sonnet"),
    )


def test_the_model_s_answer_becomes_the_triage(engine, model):
    verdict = {
        "category": "duplicate",
        "confidence": 0.9,
        "is_duplicate": True,
        "duplicate_of": 2,
        "labels_to_add": ["duplicate"],
    }
    made = model(
        text(MessageRole.USER, '```json\n{"category": "spam"}\n```'),
        AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(type=ContentBlockType.THINKING, text="hmm"),
                ContentBlock(type=ContentBlockType.TOOL_USE, tool_name="Read"),
                ContentBlock(
                    type=ContentBlockType.TEXT, text="Looks like #2.\n```json\n"
                ),
            ],
        ),
        text(MessageRole.ASSISTANT, json.dumps(verdict) + "\n```"),
    )
    result = asyncio.run(engine.triage_single_issue(ISSUE, OTHERS))
    assert result.category is TriageCategory.DUPLICATE
    assert (result.confidence, result.duplicate_of) == (0.9, 2)
    assert result.labels_to_add == ["duplicate"]
    assert (result.issue_number, result.repo) == (4, "own/repo")

    client = made[0]
    assert client.options["agent_type"] == "issue_triage"
    assert client.options["model"].startswith("claude-")  # "sonnet" resolved
    prompt = client.prompts[0]
    assert prompt.startswith(engine.prompt_manager.get_triage_prompt())
    assert "## Issue #4" in prompt
    assert "\nLabels: bug, web\n" in prompt
    assert "- #2: Login fails on Firefox" in prompt
    assert "#3" not in prompt


def test_a_model_that_fails_leaves_an_unsure_feature(engine, model, capsys):
    model(RuntimeError("provider down"))
    result = asyncio.run(engine.triage_single_issue(ISSUE, [ISSUE]))
    assert (result.category, result.confidence) == (TriageCategory.FEATURE, 0.0)
    assert "Triage error for #4: provider down" in capsys.readouterr().out


def test_the_context_shows_at_most_five_look_alikes(tmp_path):
    engine = TriageEngine.__new__(TriageEngine)
    engine.github_dir = tmp_path
    issue = {
        "number": 1,
        "title": "Crash",
        "author": {"login": "ann"},
        "createdAt": "2026-11-01",
    }
    alikes = [{"number": n, "title": f"Crash {n}"} for n in range(2, 9)]
    context = engine.build_triage_context(issue, [issue, *alikes])
    assert "\nLabels:\n</user_content>" in context
    assert "No description" in context
    listed = [line for line in context.splitlines() if line.startswith("- #")]
    assert listed == [f"- #{n}: Crash {n}" for n in range(2, 7)]

    untitled = {**issue, "title": ""}
    assert "Potential Duplicates" not in engine.build_triage_context(
        untitled, [untitled, {"number": 9, "title": "Other"}]
    )
