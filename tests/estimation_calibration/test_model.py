"""The calibration model: factors, ranges, outliers, adjustments, quality."""

from __future__ import annotations

import pytest
from estimation_calibration import calibrate
from estimation_calibration.model import (
    MIN_SAMPLES,
    fit,
    positive,
    ratio,
    split_outliers,
)
from estimation_calibration.store import _empty

BASE = {"cost_usd": 2.0, "tokens": 100_000, "qa_iterations": 2.0, "files": 4}


def _sample(category="backend", cost=(1.0, 1.5), provider="anthropic", **extra):
    estimated, actual = cost
    return {
        "spec": extra.pop("spec", f"s-{id(extra)}"),
        "category": category,
        "provider": provider,
        "estimated": {"cost_usd": estimated, "tokens": 1000},
        "actual": {"cost_usd": actual, "tokens": 1200},
        **extra,
    }


def _data(samples=(), adjustments=()):
    data = _empty()
    data["samples"] = list(samples)
    data["adjustments"] = list(adjustments)
    return data


@pytest.mark.parametrize(
    "value, expected",
    [(2, 2.0), (0.5, 0.5), (0, None), (-1, None), (True, None), ("3", None),
     (float("nan"), None), (float("inf"), None), (None, None)],
)
def test_positive_keeps_only_finite_numbers_above_zero(value, expected):
    assert positive(value) == expected


def test_ratio_needs_both_figures():
    assert ratio({"estimated": {"files": 2}, "actual": {"files": 3}}, "files") == 1.5
    assert ratio({"estimated": {"files": 2}, "actual": {}}, "files") is None
    assert ratio({"estimated": "x", "actual": {"files": 3}}, "files") is None


def test_split_outliers_leaves_a_small_set_alone():
    assert split_outliers([1.0, 50.0, 2.0]) == ([1.0, 50.0, 2.0], 0)


def test_split_outliers_drops_a_spec_that_exploded():
    kept, dropped = split_outliers([1.0, 1.1, 0.9, 1.2, 1.0, 9.0])
    assert dropped == 1
    assert 9.0 not in kept


def test_fit_needs_min_samples_after_outliers():
    assert fit([1.0] * (MIN_SAMPLES - 1)) is None
    # Five values, one of them an outlier: four left, not enough.
    assert fit([1.0, 1.0, 1.0, 1.0, 40.0]) is None


def test_fit_confidence_grows_with_the_dataset():
    small = fit([1.4, 1.5, 1.5, 1.6, 1.5])
    large = fit([1.4, 1.5, 1.5, 1.6, 1.5] * 4)
    assert small["factor"] == pytest.approx(1.5)
    assert small["low"] <= small["factor"] <= small["high"]
    assert large["confidence"] > small["confidence"]
    assert large["confidence"] <= 0.95


def test_fit_wide_scatter_lowers_confidence():
    tight = fit([1.0, 1.0, 1.05, 0.95, 1.0, 1.0])
    loose = fit([0.4, 0.8, 1.0, 1.3, 1.9, 1.0])
    assert loose["confidence"] < tight["confidence"]


def test_empty_repository_falls_back_to_the_generic_estimate():
    result = calibrate(_data(), "backend", BASE, 5)
    assert result["status"] == "insufficient_history"
    cost = result["metrics"]["cost_usd"]
    assert cost == {
        "base": 2.0, "value": 2.0, "low": None, "high": None, "factor": 1.0,
        "scope": "none", "samples": 0, "outliers": 0, "confidence": None,
    }
    assert result["complexity"] == {
        "base": 5, "value": 5, "bias": 0, "scope": "none", "adjustments": 0,
    }
    assert result["red_flags"] == []
    assert result["providers"] == []
    assert result["quality"]["acceptance_rate"] is None
    assert result["quality"]["mean_interval_width"] is None
    assert result["quality"]["mape"]["cost_usd"] is None


def test_category_factor_wins_over_the_repository():
    samples = [_sample("backend", (1.0, 1.5)) for _ in range(5)] + [
        _sample("frontend", (1.0, 1.0)) for _ in range(5)
    ]
    result = calibrate(_data(samples), "backend", BASE, 5)
    cost = result["metrics"]["cost_usd"]
    assert result["status"] == "calibrated"
    assert cost["scope"] == "category"
    assert cost["factor"] == pytest.approx(1.5)
    assert cost["value"] == pytest.approx(3.0)
    assert cost["low"] <= cost["value"] <= cost["high"]
    # The overrun is reported as a red flag.
    assert {"metric": "cost_usd", "factor": 1.5, "scope": "category"} in result[
        "red_flags"
    ]


def test_repository_factor_when_the_category_is_too_small():
    samples = [_sample("frontend", (1.0, 0.5)) for _ in range(6)]
    result = calibrate(_data(samples), "infra", BASE, 5)
    cost = result["metrics"]["cost_usd"]
    assert cost["scope"] == "repo"
    assert cost["factor"] == pytest.approx(0.5)
    assert result["red_flags"][0]["factor"] == pytest.approx(0.5)


def test_a_factor_near_one_is_no_red_flag():
    samples = [_sample("backend", (1.0, 1.1)) for _ in range(5)]
    result = calibrate(_data(samples), "backend", BASE, 5)
    assert all(flag["metric"] != "cost_usd" for flag in result["red_flags"])


def test_a_missing_base_figure_is_not_calibrated():
    samples = [_sample("backend", (1.0, 1.5)) for _ in range(5)]
    result = calibrate(_data(samples), "backend", {"cost_usd": None}, 5)
    assert result["metrics"]["cost_usd"]["scope"] == "none"
    assert result["metrics"]["cost_usd"]["value"] is None


def test_an_unknown_category_is_read_as_feature():
    assert calibrate(_data(), "../etc", BASE, 3)["category"] == "feature"


def test_adjustments_move_the_complexity_score():
    adjustments = [
        {"category": "backend", "base_score": 5, "adjusted_score": 8},
        {"category": "backend", "base_score": 4, "adjusted_score": 7},
        {"category": "backend", "base_score": 6, "adjusted_score": 9},
        {"category": "frontend", "base_score": 6, "adjusted_score": 5},
        {"category": "backend", "base_score": 0, "adjusted_score": 5},  # out of range
        {"category": "backend", "base_score": True, "adjusted_score": 5},
        {"category": "backend", "base_score": 5},
    ]
    result = calibrate(_data(adjustments=adjustments), "backend", BASE, 11)
    assert result["complexity"] == {
        "base": 11, "value": 13, "bias": 3, "scope": "category", "adjustments": 4,
    }
    # Another category below the threshold uses the repository's bias.
    other = calibrate(_data(adjustments=adjustments), "infra", BASE, 2)
    assert other["complexity"]["scope"] == "repo"
    assert other["complexity"]["value"] == 5


def test_providers_are_compared_once_they_have_two_samples():
    samples = [
        _sample(cost=(1.0, 0.8), provider="anthropic"),
        _sample(cost=(1.0, 0.9), provider="anthropic"),
        _sample(cost=(1.0, 1.2), provider="openai"),
        _sample(cost=(1.0, 1.2), provider=""),
        {"spec": "local", "provider": "ollama", "estimated": {"cost_usd": 1},
         "actual": {"cost_usd": 0}},
        {"spec": "local2", "provider": "ollama", "estimated": {"cost_usd": 1},
         "actual": {"cost_usd": 0}},
    ]
    rows = calibrate(_data(samples), "backend", BASE, 5)["providers"]
    assert rows == [
        {"provider": "anthropic", "samples": 2, "cost_ratio": 0.85,
         "tokens_ratio": 1.2},
    ]


def test_quality_reports_mape_acceptance_and_interval_width():
    samples = [
        _sample("backend", (1.0, 2.0), spec="a", adjusted=True,
                shown={"cost_usd": 1.5}),
        _sample("backend", (1.0, 2.0), spec="b"),
        _sample("backend", (1.0, 2.0), spec="c"),
        _sample("backend", (1.0, 2.0), spec="d"),
        _sample("backend", (1.0, 2.0), spec="e"),
    ]
    quality = calibrate(_data(samples), "backend", BASE, 5)["quality"]
    # (0.25 + 0.5 * 4) / 5
    assert quality["mape"]["cost_usd"] == pytest.approx(0.45)
    assert quality["mape"]["files"] is None
    assert quality["acceptance_rate"] == pytest.approx(0.8)
    assert quality["mean_interval_width"] == pytest.approx(0.0)
    assert quality["outliers_excluded"] == 0
