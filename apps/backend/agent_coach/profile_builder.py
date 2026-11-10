"""From observations to a personal style profile.

Each vote weighs by what kind of commit it came from and how old it is
(half-life ``HALF_LIFE_DAYS``): recent habits win over old ones. One commit
counts at most ``MAX_VOTES`` times per value, so a single large commit does
not decide alone.

A dimension is **preferred** when it has weight enough and one value holds at
least ``PREFERRED_SHARE`` of it; with weight but no clear winner it is
**indifferent**, and an indifferent dimension is never given to an agent.

Per project and per language: a person who writes snake_case in Python and
camelCase in TypeScript has two answers, not a contradiction.
"""

from __future__ import annotations

import time
from collections import defaultdict
from pathlib import Path

from .style_dimensions import DIMENSIONS
from .style_lint import lint_rules
from .style_observer import Observation, observe

__all__ = [
    "HALF_LIFE_DAYS",
    "PREFERRED_SHARE",
    "WEIGHTS",
    "build_profile",
    "outcomes",
    "tally",
]

HALF_LIFE_DAYS = 90
PREFERRED_SHARE = 0.7
MIN_WEIGHT = 3.0
MAX_VOTES = 5
LINT_WEIGHT = 4.0
CORRECTION_WINDOW_S = 30 * 86400
WEIGHTS = {"gold": 1.0, "accepted": 0.5, "corrected": -0.5, "team": 0.3}
_HISTORY = {"gold", "accepted", "corrected"}


def _decay(at: float, now: float) -> float:
    age_days = max(0.0, (now - at) / 86400)
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def tally(
    observations: list[Observation],
    rules: list[tuple[str, str, str, str]],
    now: float,
) -> dict[str, dict[str, dict]]:
    """Language → dimension → the measured entry (value, share, weight, state, source)."""
    weights: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    sources: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    for obs in observations:
        factor = WEIGHTS.get(obs.kind, 0.0) * _decay(obs.at, now)
        for (dim, value), count in obs.votes.items():
            if dim not in DIMENSIONS or value not in DIMENSIONS[dim]:
                continue
            amount = factor * min(count, MAX_VOTES)
            weights[obs.language, dim][value] += amount
            if amount > 0:
                sources[obs.language, dim][
                    "history" if obs.kind in _HISTORY else "project"
                ] += amount
    for language, dim, value, _file in rules:
        weights[language, dim][value] += LINT_WEIGHT
        sources[language, dim]["lint"] += LINT_WEIGHT
    profile: dict[str, dict[str, dict]] = {}
    for (language, dim), values in weights.items():
        positive = {value: weight for value, weight in values.items() if weight > 0}
        total = sum(positive.values())
        if total < MIN_WEIGHT:
            continue
        value, weight = max(positive.items(), key=lambda item: item[1])
        share = weight / total
        origin = max(sources[language, dim].items(), key=lambda item: item[1])[0]
        profile.setdefault(language, {})[dim] = {
            "value": value,
            "share": round(share, 2),
            "weight": round(total, 1),
            "state": "preferred" if share >= PREFERRED_SHARE else "indifferent",
            "source": origin,
        }
    return profile


def outcomes(merges: list[dict], removals: list[tuple[float, set[str]]]) -> list[dict]:
    """Each recorded merge, kept as is or corrected by the person within 30 days."""
    rows = []
    for merge in merges:
        at = float(merge.get("at") or 0)
        hashes = {h for h in merge.get("hashes", []) if isinstance(h, str)}
        corrected = any(
            at < when <= at + CORRECTION_WINDOW_S and hashes & removed
            for when, removed in removals
        )
        rows.append(
            {
                "at": int(at),
                "coached": merge.get("coached") is True,
                "corrected": corrected,
            }
        )
    return rows


def _metrics(rows: list[dict], languages: dict[str, dict[str, dict]]) -> dict:
    def rate(coached: bool) -> dict:
        group = [row for row in rows if row["coached"] is coached]
        kept = sum(1 for row in group if not row["corrected"])
        return {
            "merged": len(group),
            "keptAsIs": kept,
            "rate": round(100 * kept / len(group)) if group else None,
        }

    preferred = sum(
        1
        for dims in languages.values()
        for entry in dims.values()
        if entry["state"] == "preferred"
    )
    return {
        "withCoach": rate(True),
        "withoutCoach": rate(False),
        "dimensionsPreferred": preferred,
    }


def build_profile(root: Path, now: float | None = None) -> dict:
    """Read the project's history and lint config into a profile (nothing is written)."""
    now = time.time() if now is None else now
    observations, info = observe(root)
    rules = lint_rules(root)
    languages = tally(observations, rules, now)
    rows = outcomes(info.pop("merges", []), info.pop("removals", []))
    return {
        "version": 1,
        "builtAt": int(now),
        "commits": {
            kind: info.get(kind, 0)
            for kind in ("gold", "accepted", "corrected", "team", "agent")
        },
        "hasEmail": bool(info.get("email")),
        "lint": sorted({file for *_, file in rules}),
        "languages": languages,
        "metrics": _metrics(rows, languages),
    }
