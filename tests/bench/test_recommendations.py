"""The bench's recommendation per kind of card (plan of 29 October, IA3).

Per kind, the engines the bench saw resolve at least half of at least three
cards; among those within ``RECOMMEND_MARGIN`` of the best rate, the cheapest
measured one. A kind without that much evidence has no recommendation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "backend"))

from bench import recommendations  # noqa: E402
from bench.layout import results_path  # noqa: E402
from bench.results import add_records  # noqa: E402


def _records(engine, kind, outcomes, cost=None, start=0):
    provider, model, effort = engine
    return [
        {
            "runId": f"run-{provider}-{model}-{effort}-{kind}",
            "buildId": f"b{start + i}",
            "caseId": f"{kind}-{start + i}",
            "kind": kind,
            "provider": provider,
            "model": model,
            "effort": effort,
            "resolved": resolved,
            "costUsd": cost,
        }
        for i, resolved in enumerate(outcomes)
    ]


CHEAP = ("openai", "gpt-mini", "low")
STRONG = ("anthropic", "big", "high")
MIDDLE = ("google", "pro", "medium")


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    return tmp_path


def test_the_cheapest_close_to_the_best_is_recommended(project):
    add_records(
        project,
        _records(STRONG, "bug_fix", [True] * 10, cost=2.0)
        + _records(CHEAP, "bug_fix", [True] * 9 + [False], cost=0.2)
        + _records(MIDDLE, "bug_fix", [True] * 7 + [False] * 3, cost=0.05),
    )

    pick = recommendations(project)["bug_fix"]

    # 0.9 is within 0.1 of 1.0 and costs a tenth; 0.7 is too far behind.
    assert (pick["provider"], pick["model"], pick["effort"]) == CHEAP
    assert pick["rate"] == pytest.approx(0.9)
    assert pick["bestRate"] == pytest.approx(1.0)
    assert pick["cases"] == 10 and pick["considered"] == 3
    assert pick["avgCostUsd"] == pytest.approx(0.2)


def test_each_kind_has_its_own_and_all_kinds_one_too(project):
    add_records(
        project,
        _records(CHEAP, "bug_fix", [True] * 4, cost=0.1)
        + _records(STRONG, "bug_fix", [True] * 4, cost=1.0)
        + _records(CHEAP, "feature", [False] * 4, cost=0.1)
        + _records(STRONG, "feature", [True] * 4, cost=1.0),
    )

    picks = recommendations(project)

    assert picks["bug_fix"]["provider"] == "openai"
    assert picks["feature"]["provider"] == "anthropic"
    # Over every card the cheap engine resolved half: the strong one wins.
    assert picks["*"]["provider"] == "anthropic"
    # Written next to the table for the app's main process.
    data = json.loads(results_path(project).read_text(encoding="utf-8"))
    assert data["recommendations"] == picks


def test_too_little_evidence_recommends_nothing(project):
    add_records(
        project,
        # Two cards only, and one card twice.
        _records(STRONG, "docs", [True, True], cost=1.0)
        + [
            {**r, "caseId": "refactoring-0"}
            for r in _records(STRONG, "refactoring", [True] * 3, cost=1.0)
        ],
    )
    # Neither kind has three cards; together they have, for "*" only.
    assert set(recommendations(project)) == {"*"}


def test_an_engine_failing_most_cards_is_never_recommended(project):
    add_records(project, _records(CHEAP, "test", [True, False, False, False], 0.01))
    assert "test" not in recommendations(project)


def test_an_unmeasured_cost_does_not_win_on_cost(project):
    add_records(
        project,
        _records(CHEAP, "feature", [True] * 3, cost=None)
        + _records(STRONG, "feature", [True] * 3, cost=3.0),
    )
    assert recommendations(project)["feature"]["provider"] == "anthropic"


def test_records_without_a_kind_count_only_for_all_kinds(project):
    add_records(
        project,
        [{**r, "kind": None} for r in _records(STRONG, "x", [True] * 3, cost=1.0)],
    )
    assert set(recommendations(project)) == {"*"}
