"""`_add_effort` sends the Kanban level to every Claude model that takes it.

It used to test for "opus" in the model name: a Sonnet or Haiku 5.5 card on
"low" ran at the model's own default effort while the feed said "low".
"""

from __future__ import annotations

import pytest
from core import client as client_mod


@pytest.fixture(autouse=True)
def _sdk_takes_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_mod, "_claude_options_supports", lambda _name: True)
    monkeypatch.delenv("AUTO_CLAUDE_EFFORT", raising=False)


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("claude-opus-5-5", "low"),
        ("claude-sonnet-5-5", "low"),
        ("claude-sonnet-4-6", "low"),
        ("claude-haiku-5-5", "low"),
        ("claude-fable-5-1", "low"),
    ],
)
def test_effort_reaches_every_model_that_takes_it(model: str, expected: str) -> None:
    options: dict = {}
    client_mod._add_effort(options, model, 1024, "coder")
    assert options["effort"] == expected


@pytest.mark.parametrize("model", ["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5.5"])
def test_models_without_effort_get_no_field(model: str) -> None:
    options: dict = {}
    client_mod._add_effort(options, model, 16384, "qa_reviewer")
    assert "effort" not in options


def test_the_environment_still_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTO_CLAUDE_EFFORT", "max")
    options: dict = {}
    client_mod._add_effort(options, "claude-sonnet-5-5", None, "coder")
    assert options["effort"] == "max"
