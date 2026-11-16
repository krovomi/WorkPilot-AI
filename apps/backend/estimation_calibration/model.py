"""The calibration model: a correction factor per repository and category.

For each metric the estimator gives (cost, tokens, QA iterations, files
changed), the ratio ``actual / estimated`` of every merged spec is kept. The
factor is the median of those ratios once outliers are excluded (Tukey's
fences, 1.5 × IQR), and the range shown is the 20th to 80th percentile of the
same ratios applied to the new estimate. A category needs ``MIN_SAMPLES`` of
its own before it is used; below that the repository's factor is used, and
below that the generic estimate is shown with "not enough history".

A median of ratios rather than a regression: with the handful of samples a
repository has, it is the estimator that does not swing on one odd spec, and
it needs no new dependency. No model call, so every provider feeds and reads
the same dataset.
"""

from __future__ import annotations

import math
import statistics
from typing import Any

from .categories import valid_category

METRICS: tuple[str, ...] = ("cost_usd", "tokens", "qa_iterations", "files")
#: Samples a scope (a category, or the whole repository) needs before it is used.
MIN_SAMPLES = 5
#: Manual adjustments a scope needs before they move the complexity score.
MIN_ADJUSTMENTS = 3
#: A factor at or past these bounds is reported as a red flag.
RED_FLAG_HIGH = 1.3
RED_FLAG_LOW = 0.7
#: Ratios a provider needs before its own figure is reported.
MIN_PROVIDER_SAMPLES = 2


def positive(value: object) -> float | None:
    """*value* as a float when it is a finite number above zero, else None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _figure(sample: dict[str, Any], section: str, metric: str) -> float | None:
    values = sample.get(section)
    return positive(values.get(metric)) if isinstance(values, dict) else None


def ratio(sample: dict[str, Any], metric: str) -> float | None:
    """``actual / estimated`` for *metric* in *sample*, when both are known."""
    estimated = _figure(sample, "estimated", metric)
    actual = _figure(sample, "actual", metric)
    if estimated is None or actual is None:
        return None
    return actual / estimated


def split_outliers(values: list[float]) -> tuple[list[float], int]:
    """The values inside Tukey's fences, and how many were left out."""
    if len(values) < 4:
        return values, 0
    q1, median, q3 = statistics.quantiles(values, n=4, method="inclusive")
    # A floor on the spread: when most specs hit the same ratio the IQR is 0,
    # and every spec a little off would otherwise count as an outlier.
    spread = max(q3 - q1, 0.1 * median)
    low, high = q1 - 1.5 * spread, q3 + 1.5 * spread
    kept = [v for v in values if low <= v <= high]
    return kept, len(values) - len(kept)


def fit(ratios: list[float]) -> dict[str, Any] | None:
    """Factor, range and confidence from *ratios*; None below ``MIN_SAMPLES``."""
    kept, outliers = split_outliers(ratios)
    if len(kept) < MIN_SAMPLES:
        return None
    factor = statistics.median(kept)
    deciles = statistics.quantiles(kept, n=10, method="inclusive")
    low, high = deciles[1], deciles[7]
    width = (high - low) / factor
    # Grows with the dataset, shrinks when past specs scatter widely.
    confidence = len(kept) / (len(kept) + MIN_SAMPLES) * max(0.3, 1 - width / 2)
    return {
        "factor": factor,
        "low": low,
        "high": high,
        "samples": len(kept),
        "outliers": outliers,
        "confidence": round(min(0.95, confidence), 2),
    }


def _ratios(samples: list[dict[str, Any]], metric: str) -> list[float]:
    return [r for s in samples if (r := ratio(s, metric)) is not None]


def _metric(
    samples: list[dict[str, Any]], metric: str, category: str, base: object
) -> dict[str, Any]:
    scope = "category"
    found = fit(_ratios([s for s in samples if s.get("category") == category], metric))
    if found is None:
        scope = "repo"
        found = fit(_ratios(samples, metric))
    value = positive(base)
    if found is None or value is None:
        return {
            "base": value,
            "value": value,
            "low": None,
            "high": None,
            "factor": 1.0,
            "scope": "none",
            "samples": 0,
            "outliers": 0,
            "confidence": None,
        }
    return {
        "base": value,
        "value": round(value * found["factor"], 4),
        "low": round(value * found["low"], 4),
        "high": round(value * found["high"], 4),
        "factor": round(found["factor"], 4),
        "scope": scope,
        "samples": found["samples"],
        "outliers": found["outliers"],
        "confidence": found["confidence"],
    }


def _score(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 1 <= value <= 13 else None


def _complexity(
    adjustments: list[dict[str, Any]], category: str, base_score: int
) -> dict[str, Any]:
    diffs: dict[str, list[int]] = {"category": [], "repo": []}
    for entry in adjustments:
        base, adjusted = (
            _score(entry.get("base_score")),
            _score(entry.get("adjusted_score")),
        )
        if base is None or adjusted is None:
            continue
        diffs["repo"].append(adjusted - base)
        if entry.get("category") == category:
            diffs["category"].append(adjusted - base)
    scope = next(
        (name for name in ("category", "repo") if len(diffs[name]) >= MIN_ADJUSTMENTS),
        "none",
    )
    bias = statistics.median(diffs[scope]) if scope != "none" else 0
    return {
        "base": base_score,
        "value": max(1, min(13, round(base_score + bias))),
        "bias": bias,
        "scope": scope,
        "adjustments": len(diffs["repo"]),
    }


def _providers(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        provider = sample.get("provider")
        if isinstance(provider, str) and provider:
            grouped.setdefault(provider, []).append(sample)
    rows = []
    for provider in sorted(grouped):
        figures = {}
        for metric in ("cost_usd", "tokens"):
            values = _ratios(grouped[provider], metric)
            enough = len(values) >= MIN_PROVIDER_SAMPLES
            figures[metric] = round(statistics.median(values), 4) if enough else None
        if figures["cost_usd"] is not None or figures["tokens"] is not None:
            rows.append(
                {
                    "provider": provider,
                    "samples": len(grouped[provider]),
                    "cost_ratio": figures["cost_usd"],
                    "tokens_ratio": figures["tokens"],
                }
            )
    return rows


def _mape(samples: list[dict[str, Any]], metric: str) -> float | None:
    errors = []
    for sample in samples:
        actual = _figure(sample, "actual", metric)
        shown = _figure(sample, "shown", metric) or _figure(sample, "estimated", metric)
        if actual is not None and shown is not None:
            errors.append(abs(actual - shown) / actual)
    return round(statistics.fmean(errors), 4) if errors else None


def _quality(samples: list[dict[str, Any]], metrics: dict[str, Any]) -> dict[str, Any]:
    widths = [
        (m["high"] - m["low"]) / m["value"]
        for m in metrics.values()
        if m["scope"] != "none"
    ]
    return {
        "mape": {metric: _mape(samples, metric) for metric in METRICS},
        "acceptance_rate": (
            round(sum(1 for s in samples if not s.get("adjusted")) / len(samples), 4)
            if samples
            else None
        ),
        "mean_interval_width": round(statistics.fmean(widths), 4) if widths else None,
        "outliers_excluded": sum(m["outliers"] for m in metrics.values()),
    }


def calibrate(
    data: dict[str, Any],
    category: str,
    base: dict[str, object],
    base_score: int,
) -> dict[str, Any]:
    """The calibrated estimate of a new spec, from a repository's *data*.

    *base* maps each of ``METRICS`` to the estimator's generic figure; the
    result keeps it under ``base`` beside the calibrated ``value`` so the
    sample recorded at merge time compares the actuals with the generic
    figure, and factors never compound.
    """
    category = valid_category(category) or "feature"
    samples = data["samples"]
    metrics = {m: _metric(samples, m, category, base.get(m)) for m in METRICS}
    red_flags = [
        {"metric": m, "factor": row["factor"], "scope": row["scope"]}
        for m, row in metrics.items()
        if row["scope"] != "none"
        and (row["factor"] >= RED_FLAG_HIGH or row["factor"] <= RED_FLAG_LOW)
    ]
    calibrated = any(row["scope"] != "none" for row in metrics.values())
    return {
        "status": "calibrated" if calibrated else "insufficient_history",
        "category": category,
        "samples": len(samples),
        "min_samples": MIN_SAMPLES,
        "reset_at": data["reset_at"],
        "metrics": metrics,
        "complexity": _complexity(data["adjustments"], category, base_score),
        "red_flags": red_flags,
        "providers": _providers(samples),
        "quality": _quality(samples, metrics),
    }
