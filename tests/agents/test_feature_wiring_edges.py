"""The corners of the opt-in wiring: what counts as a model choice, the
context budget, and the files the packed context leaves out."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents import feature_wiring
from agents.feature_wiring import (
    COGNITIVE_CONTEXT_BUDGET_ENV_VAR,
    COGNITIVE_CONTEXT_DEFAULT_BUDGET,
    COGNITIVE_CONTEXT_ENV_VAR,
    card_kind,
    optimized_subtask_context,
)


def test_a_run_without_a_spec_has_no_card_kind_and_no_model_choice() -> None:
    assert card_kind(None) is None
    assert feature_wiring._user_made_explicit_model_choice(None, None) is False


@pytest.mark.parametrize(
    "metadata",
    [["model", "opus"], {"isAutoProfile": False, "phaseModels": {}}, {}],
)
def test_metadata_that_names_no_model_is_no_choice(
    tmp_path: Path, metadata: object
) -> None:
    (tmp_path / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    assert feature_wiring._user_made_explicit_model_choice(tmp_path, None) is False


@pytest.mark.parametrize(
    ("raw", "budget"),
    [("", COGNITIVE_CONTEXT_DEFAULT_BUDGET), ("50", COGNITIVE_CONTEXT_DEFAULT_BUDGET)],
)
def test_a_budget_unset_or_too_small_falls_back_to_the_default(
    monkeypatch: pytest.MonkeyPatch, raw: str, budget: int
) -> None:
    monkeypatch.setenv(COGNITIVE_CONTEXT_BUDGET_ENV_VAR, raw)

    assert feature_wiring._budget_from_env() == budget


def test_files_over_the_budget_are_named_not_inlined(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(COGNITIVE_CONTEXT_ENV_VAR, "1")
    monkeypatch.setenv(COGNITIVE_CONTEXT_BUDGET_ENV_VAR, "100")
    shop = tmp_path / "Shop"
    shop.mkdir()
    (shop / "Cart.cs").write_text("public class Cart { }\n", encoding="utf-8")
    (shop / "Big.cs").write_text(
        "".join(f"public int Field{i} = {i}; // padding\n" for i in range(2000)),
        encoding="utf-8",
    )
    subtask = {
        "description": "Add a total to the Cart",
        "files_to_modify": ["Shop/Cart.cs"],
        "patterns_from": ["Shop/Big.cs"],
    }

    section = optimized_subtask_context(tmp_path, subtask)

    assert section is not None
    assert "### `Shop/Cart.cs`" in section
    assert "Not inlined (over budget, read them if needed): `Shop/Big.cs`" in section


def test_a_run_without_a_spec_stays_on_claude() -> None:
    assert feature_wiring.task_provider(None) == "anthropic"
