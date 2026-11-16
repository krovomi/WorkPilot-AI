"""The AI merge of a file both sides changed asks the user's provider.

It used to call the Claude SDK and refuse to run without a Claude token, so a
project on Copilot, OpenAI or a local model could not merge a conflicting file.
"""

from __future__ import annotations

import asyncio

import core.client
import core.oneshot
import pytest
from core.workspace import ParallelMergeTask, _run_parallel_merges
from phase_config import MODEL_ID_MAP

BASE = "def total(items):\n    return sum(items)\n"
MAIN = "def total(items):\n    return sum(items) + 1\n"
TASK = "def total(items):\n    return sum(items) - 1\n"
MERGED = "def total(items):\n    return sum(items)\n"


class Provider:
    """Stands in for the one-shot completion; answers in turn."""

    def __init__(self, *answers, error=None):
        self.answers = list(answers)
        self.error = error
        self.calls: list[dict] = []

    async def __call__(self, prompt, **kwargs):
        self.calls.append(kwargs)
        if self.error and kwargs.get("on_error"):
            kwargs["on_error"](self.error)
        return self.answers.pop(0) if self.answers else ""


@pytest.fixture
def merge(monkeypatch, tmp_path):
    def run(provider_name, provider, spec=True):
        if spec:
            (tmp_path / ".workpilot" / "specs" / "001-total").mkdir(parents=True)
        seen = []

        def peek(spec_dir=None):
            seen.append(spec_dir)
            return provider_name

        monkeypatch.setattr(core.client, "peek_active_provider", peek)
        monkeypatch.setattr(core.oneshot, "oneshot_completion", provider)
        task = ParallelMergeTask(
            file_path="src/total.py",
            main_content=MAIN,
            worktree_content=TASK,
            base_content=BASE,
            spec_name="001-total",
            project_dir=tmp_path,
        )
        (result,) = asyncio.run(_run_parallel_merges([task], tmp_path))
        return result, seen

    return run


@pytest.mark.parametrize("name", ["copilot", "openai", "ollama"])
def test_another_provider_merges_with_its_own_model(merge, name, tmp_path):
    provider = Provider(MERGED)

    result, seen = merge(name, provider)

    assert result.success is True
    assert result.merged_content.strip() == MERGED.strip()
    assert result.was_auto_merged is False
    assert len(provider.calls) == 1
    (call,) = provider.calls
    assert call["model"] is None
    assert call["thinking_level"] is None
    assert call["project_dir"] == str(tmp_path)
    assert call["spec_dir"] == str(tmp_path / ".workpilot" / "specs" / "001-total")
    assert seen == [tmp_path / ".workpilot" / "specs" / "001-total"]


def test_claude_tries_a_quick_model_then_a_capable_one(merge):
    provider = Provider("", MERGED)

    result, _ = merge("claude", provider)

    assert result.success is True
    assert [(c["model"], c["thinking_level"]) for c in provider.calls] == [
        (MODEL_ID_MAP["haiku"], "low"),
        (MODEL_ID_MAP["sonnet"], "high"),
    ]


def test_the_providers_own_error_is_reported(merge):
    provider = Provider(error={"message": "Copilot rate limit reached"})

    result, _ = merge("copilot", provider)

    assert result.success is False
    assert result.error == "AI merge failed: Copilot rate limit reached"


def test_an_explanation_instead_of_code_is_not_a_merge(merge):
    provider = Provider("I cannot merge this without more context.")

    result, _ = merge("openai", provider)

    assert result.success is False
    assert "explanation instead of code" in result.error


def test_without_a_spec_directory_the_provider_is_still_asked(merge):
    provider = Provider(MERGED)

    result, seen = merge("copilot", provider, spec=False)

    assert result.success is True
    assert seen == [None]
    assert provider.calls[0]["spec_dir"] is None
