"""A session plans for the window it can pay for, not the one announced.

Grok, Gemini Pro, several GPT models and Claude Haiku 5.5 bill every token of a
prompt past a size at two to five times the rate. A compaction threshold set as
a share of the announced window (1M tokens for Gemini 3.1 Pro) let a session
cross that line long before it compacted.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from context_mgmt import (
    ContextGuard,
    codex_auto_compact_limit,
    native_auto_compact_env,
)
from context_mgmt.windows import effective_window, resolve_context_window
from cost_intelligence.catalog import LONG_CONTEXT_THRESHOLDS, long_context_threshold


@pytest.mark.parametrize(
    ("model", "window", "expected"),
    [
        ("gemini-3.1-pro", 1_000_000, 200_000),
        ("gemini-3.1-pro-preview", 1_000_000, 200_000),  # a tagged id resolves
        ("claude-haiku-5-5", 200_000, 100_000),
        ("anthropic/claude-haiku-5-5", 200_000, 100_000),  # vendor/model
        ("grok-4.7", 256_000, 199_999),  # 200K "or more" bills 2×
        ("gpt-5.4", 1_000_000, 272_000),
        ("gpt-5.4", 256_000, 256_000),  # the window is already smaller
        ("gpt-5.4-mini", 400_000, 400_000),  # not on the page: no threshold
        ("claude-opus-5-5", 200_000, 200_000),
        (None, 128_000, 128_000),
    ],
)
def test_effective_window(model, window, expected):
    assert effective_window(model, window) == expected


def test_every_threshold_names_a_priced_model():
    from cost_intelligence.catalog import _DEFAULT_CATALOG

    priced = {model for models in _DEFAULT_CATALOG.values() for model in models}
    assert set(LONG_CONTEXT_THRESHOLDS) <= priced
    assert long_context_threshold("") is None


def _spec(tmp_path: Path, threshold: int = 60) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    meta = {
        "taskId": "t1",
        "contextPolicy": {"mode": "auto", "thresholdPct": threshold},
    }
    (spec / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return spec


def test_claude_compacts_at_the_threshold_of_the_payable_window(tmp_path):
    spec = _spec(tmp_path)
    window = resolve_context_window("claude-haiku-5-5")
    expected = int(60 * effective_window("claude-haiku-5-5", window) / window)
    assert native_auto_compact_env(spec, "claude-haiku-5-5") == {
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(expected)
    }
    assert expected < 60
    # A model without a threshold keeps the task's percentage as it was.
    assert native_auto_compact_env(spec, "claude-opus-5-5") == {
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60"
    }


def test_codex_compacts_at_the_threshold_of_the_payable_window(tmp_path):
    spec = _spec(tmp_path)
    assert codex_auto_compact_limit(spec, 1_000_000, "gpt-5.4") == 163_200
    assert codex_auto_compact_limit(spec, 200_000) == 120_000


class _Client:
    context_window_tokens = 1_000_000
    last_context_tokens = 100_000
    context_usage_source = "reported"


def test_the_guard_measures_against_the_payable_window(tmp_path):
    spec = _spec(tmp_path)
    guard = ContextGuard(
        spec_dir=spec,
        project_dir=tmp_path,
        phase="coding",
        subtask_id="s-1",
        client=_Client(),
        provider="google",
        model="gemini-3.1-pro",
    )
    guard._measure()
    assert guard.window == 200_000
    assert guard.percent == 50.0  # not 10 % of the announced million
