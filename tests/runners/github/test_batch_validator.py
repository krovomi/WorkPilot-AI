"""Checking that issues grouped by similarity really belong in one fix.

Issue batching groups look-alike issues into one spec; `BatchValidator`
(runners/github/batch_validator.py) asks a model whether a group shares a root
cause, and how to split it when it does not. A validation that cannot run must
never block batching, so every failure answers "valid, unsure". The model is a
stand-in `create_simple_client` that answers with the Claude SDK's messages.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock, ThinkingBlock, UserMessage
from runners.github import batch_validator
from runners.github.batch_validator import (
    BatchValidationResult,
    BatchValidator,
    validate_batches,
)

ISSUES = [
    {
        "issue_number": 1,
        "title": "Login fails on Safari",
        "body": "x" * 600,
        "labels": ["bug", "auth"],
    },
    {
        "issue_number": 2,
        "title": "Login fails on Firefox",
        "similarity_to_primary": 0.82,
    },
]


class FakeClient:
    def __init__(self, replies, options):
        self.replies = replies
        self.options = options
        self.prompts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompts.append(prompt)

    async def receive_response(self):
        for reply in self.replies:
            yield reply


@pytest.fixture
def model(monkeypatch):
    made = []
    replies = []

    def create_simple_client(**options):
        if isinstance(replies[0], BaseException):
            raise replies[0]
        client = FakeClient(list(replies), options)
        made.append(client)
        return client

    monkeypatch.setattr(
        importlib.import_module("core.simple_client"),
        "create_simple_client",
        create_simple_client,
    )

    def answer(*messages):
        replies[:] = messages
        return made

    return answer


def says(text: str) -> AssistantMessage:
    return AssistantMessage(content=[TextBlock(text=text)], model="m")


def validate(tmp_path, issues=ISSUES, themes=("login",)) -> BatchValidationResult:
    validator = BatchValidator(project_dir=tmp_path, model="sonnet", thinking_budget=99)
    return asyncio.run(validator.validate_batch("b-1", 1, issues, list(themes)))


def test_the_model_can_split_a_batch(tmp_path, model):
    made = model(
        UserMessage(content="ignored"),
        AssistantMessage(
            content=[
                ThinkingBlock(thinking="hm", signature="s"),
                TextBlock(text="```json\n"),
            ],
            model="m",
        ),
        says(
            json.dumps(
                {
                    "is_valid": False,
                    "confidence": 0.8,
                    "reasoning": "Different browsers, different bugs",
                    "suggested_splits": [[1], [2]],
                    "common_theme": "login",
                }
            )
            + "\n```"
        ),
    )
    result = validate(tmp_path)
    assert result.to_dict() == {
        "batch_id": "b-1",
        "is_valid": False,
        "confidence": 0.8,
        "reasoning": "Different browsers, different bugs",
        "suggested_splits": [[1], [2]],
        "common_theme": "login",
    }
    client = made[0]
    assert client.options["agent_type"] == "batch_validation"
    assert client.options["model"].startswith("claude-")  # "sonnet" resolved
    assert client.options["max_thinking_tokens"] == 99
    prompt = client.prompts[0]
    assert "Batch ID: b-1" in prompt and "Detected Themes: login" in prompt
    assert "- Labels: bug, auth" in prompt
    assert "x" * 500 + "..." in prompt and "x" * 501 not in prompt
    assert "- Labels: none" in prompt
    assert "- Similarity to primary: 82%" in prompt
    # Nothing is left in the project.
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "reply",
    [
        '```\n{"is_valid": true, "confidence": 0.9}\n```',
        'Sure: {"is_valid": true, "confidence": 0.9} hope that helps',
        '```json {"is_valid": true, "confidence": 0.9}',
        '``` {"is_valid": true, "confidence": 0.9}',
    ],
)
def test_the_answer_is_found_inside_or_outside_a_fence(tmp_path, model, reply):
    model(says(reply))
    result = validate(tmp_path, themes=())
    assert (result.is_valid, result.confidence) == (True, 0.9)
    assert result.reasoning == "No reasoning provided"
    assert result.common_theme == ""


def test_an_answer_with_no_json_counts_as_valid(tmp_path, model):
    model(says("I think they belong together."))
    result = validate(tmp_path)
    assert (result.is_valid, result.confidence) == (True, 0.5)
    assert result.reasoning.startswith("Validation error (assuming valid):")
    assert result.common_theme == "login"


def test_a_model_that_cannot_start_does_not_block_batching(tmp_path, model):
    model(ValueError("unknown agent type"))
    result = validate(tmp_path, themes=())
    assert result.is_valid is True
    assert result.reasoning == "Validation error (assuming valid): unknown agent type"
    assert result.common_theme == ""


def test_a_single_issue_needs_no_model(tmp_path, model):
    made = model(says("unused"))
    result = validate(tmp_path, issues=ISSUES[:1])
    assert (result.is_valid, result.confidence, result.common_theme) == (
        True,
        1.0,
        "login",
    )
    assert validate(tmp_path, issues=[], themes=()).common_theme == "single issue"
    assert made == []


def test_without_the_sdk_batches_pass_unchecked(tmp_path, model, monkeypatch, caplog):
    monkeypatch.setattr(batch_validator, "CLAUDE_SDK_AVAILABLE", False)
    made = model(says("unused"))
    result = validate(tmp_path)
    assert result.reasoning == "Validation skipped - Claude SDK not available"
    assert result.common_theme == "login"
    assert validate(tmp_path, themes=()).common_theme == ""
    assert made == []
    assert "Batch validation will be skipped" in caplog.text


def test_several_batches_are_validated_in_order(tmp_path, model, monkeypatch):
    monkeypatch.chdir(tmp_path)
    model(says('{"is_valid": true, "confidence": 1.0, "common_theme": "login"}'))
    results = asyncio.run(
        validate_batches(
            [
                {"batch_id": "a", "primary_issue": 1, "issues": ISSUES},
                {
                    "batch_id": "b",
                    "primary_issue": 3,
                    "issues": ISSUES[:1],
                    "common_themes": ["typo"],
                },
            ]
        )
    )
    assert [(r.batch_id, r.common_theme) for r in results] == [
        ("a", "login"),
        ("b", "typo"),
    ]
