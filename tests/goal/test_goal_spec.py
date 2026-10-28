"""The goal file: what reads as a goal, and what is refused rather than ignored."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from goal.spec import GOAL_FILENAME, GoalConfigError, load_goal, parse_goal


def test_a_minimal_goal_takes_the_defaults():
    spec = parse_goal({"command": "  pytest -q  "})
    assert spec.command == "pytest -q"
    assert spec.expected_exit == 0
    assert spec.timeout_s == 600
    assert spec.max_rounds is None
    assert spec.max_cost_usd is None
    assert spec.protected == ()


def test_every_field_is_read():
    spec = parse_goal(
        {
            "command": "npm test",
            "expectedExit": 1,
            "timeoutSeconds": 30,
            "maxRounds": 4,
            "maxCostUsd": 2.5,
            "protected": ["tests/**", "tests\\unit", "tests/**"],
        }
    )
    assert (spec.expected_exit, spec.timeout_s, spec.max_rounds) == (1, 30, 4)
    assert spec.max_cost_usd == 2.5
    assert spec.protected == ("tests/**", "tests/unit")


@pytest.mark.parametrize(
    "raw",
    [
        [],
        {},
        {"command": ""},
        {"command": "a\nb"},
        {"command": "x", "expectedExit": "0"},
        {"command": "x", "expectedExit": True},
        {"command": "x", "expectedExit": 256},
        {"command": "x", "timeoutSeconds": 1},
        {"command": "x", "maxRounds": 0},
        {"command": "x", "maxRounds": 51},
        {"command": "x", "maxCostUsd": 0},
        {"command": "x", "maxCostUsd": float("nan")},
        {"command": "x", "maxCostUsd": "3"},
        {"command": "x", "protected": "tests"},
        {"command": "x", "protected": ["/etc/passwd"]},
        {"command": "x", "protected": ["C:/repo/tests"]},
        {"command": "x", "protected": ["../outside"]},
        {"command": "x", "protected": [""]},
    ],
)
def test_a_goal_that_cannot_be_checked_is_refused(raw):
    with pytest.raises(GoalConfigError):
        parse_goal(raw)


def test_no_file_is_no_goal(tmp_path: Path):
    assert load_goal(tmp_path, None) is None


def test_the_first_directory_with_a_goal_wins(tmp_path: Path):
    main, worktree = tmp_path / "main", tmp_path / "wt"
    main.mkdir()
    worktree.mkdir()
    (main / GOAL_FILENAME).write_text(json.dumps({"command": "new"}), encoding="utf-8")
    (worktree / GOAL_FILENAME).write_text(
        json.dumps({"command": "old"}), encoding="utf-8"
    )
    assert load_goal(main, worktree).command == "new"
    assert load_goal(None, worktree).command == "old"


def test_an_unreadable_file_is_an_error_not_no_goal(tmp_path: Path):
    (tmp_path / GOAL_FILENAME).write_text("{not json", encoding="utf-8")
    with pytest.raises(GoalConfigError):
        load_goal(tmp_path)


def test_a_symlinked_goal_is_refused(tmp_path: Path):
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps({"command": "true"}), encoding="utf-8")
    (tmp_path / GOAL_FILENAME).symlink_to(target)
    with pytest.raises(GoalConfigError):
        load_goal(tmp_path)
