"""Each recorded session names the app's AI account it ran on, when the app said.

The app starts an agent with ``WORKPILOT_AI_ACCOUNTS`` (provider → account id);
the cost ledger keeps the id of the session's provider so the app can add up
each account's month. The variable comes from the environment, so an odd value
is no account, never a crash nor a stray string in the ledger.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core import usage_tracker
from core.usage_tracker import record_session_usage
from foundation.ai_account import ENV_VAR, account_for


@pytest.fixture(autouse=True)
def _no_analytics_db(monkeypatch):
    monkeypatch.setattr(
        usage_tracker, "_append_token_usage_to_db", lambda *a, **k: None
    )


def _record(tmp_path: Path, provider: str) -> dict:
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)
    record_session_usage(
        spec_dir, tmp_path, "coding", "coder", "gpt-5", provider, 100, 50, 0.01
    )
    data = json.loads(
        (tmp_path / ".workpilot" / "cost_data.json").read_text(encoding="utf-8")
    )
    return data["usages"][-1]


def test_the_session_keeps_the_account_of_its_provider(tmp_path, monkeypatch):
    monkeypatch.setenv(
        ENV_VAR, json.dumps({"openai": "acc-1", "claude": "claude:work"})
    )
    assert _record(tmp_path, "openai")["account_id"] == "acc-1"


def test_a_session_without_an_account_records_none(tmp_path, monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)
    assert "account_id" not in _record(tmp_path, "mistral")


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("anthropic", "claude:work"),
        ("claude", "claude:work"),
        ("Gemini", "g-1"),
        ("google", "g-1"),
        ("deepseek", None),
    ],
)
def test_backend_names_map_to_the_apps(provider, expected):
    env = {ENV_VAR: json.dumps({"claude": "claude:work", "google": "g-1"})}
    assert account_for(provider, env) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[1, 2]",
        json.dumps({"openai": "has a space"}),
        json.dumps({"openai": "x" * 101}),
        json.dumps({"openai": 12}),
        json.dumps({"openai": "../../etc"}),
        "{" + " " * 5000 + "}",
    ],
)
def test_an_odd_value_is_no_account(raw):
    assert account_for("openai", {ENV_VAR: raw}) is None


def test_the_account_comes_from_the_process_environment(monkeypatch):
    monkeypatch.setenv(ENV_VAR, json.dumps({"openai": "acc-2"}))
    assert account_for("openai") == "acc-2"
