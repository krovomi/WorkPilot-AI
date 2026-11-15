"""Categories and the per-dimension breakdown, read from the task's words."""

from __future__ import annotations

import pytest
from estimation_calibration import CATEGORIES, breakdown, categorize
from estimation_calibration.categories import valid_category


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Fix the crash on login", "bug_fix"),
        ("Add a CI pipeline step for Docker", "infra"),
        ("New settings page with a form", "frontend"),
        ("Add an endpoint and a database migration", "backend"),
        ("Support exporting reports", "feature"),
        ("Rebuild the guidance", "feature"),  # "ui" inside a word is no match
    ],
)
def test_categorize(text, expected):
    assert categorize(text) == expected
    assert expected in CATEGORIES


def test_valid_category_is_a_closed_list():
    assert valid_category("infra") == "infra"
    assert valid_category("rm -rf") is None
    assert valid_category(3) is None


def test_breakdown_marks_a_dimension_without_signal_uncertain():
    rows = {row["key"]: row for row in breakdown("Rename a label", 1)}
    assert list(rows) == ["algorithmic", "integration", "conflict_risk", "test_effort"]
    assert rows["algorithmic"] == {
        "key": "algorithmic", "level": "low", "signals": [], "uncertain": True,
    }
    assert rows["conflict_risk"]["level"] == "medium"
    assert rows["conflict_risk"]["signals"] == ["rename"]


def test_breakdown_counts_files_and_caps_at_high():
    rows = {
        row["key"]: row
        for row in breakdown("Refactor the shared core with a migration and tests", 9)
    }
    assert rows["conflict_risk"]["level"] == "high"
    assert rows["conflict_risk"]["signals"][-1] == "files"
    assert rows["test_effort"]["signals"] == ["migration", "tests", "files"]
    assert rows["test_effort"]["uncertain"] is False
