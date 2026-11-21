"""The build's attempt history when its files are damaged or the plan disagrees.

`tests/test_recovery.py` pins the history across sessions; these pin what the
manager does with a corrupt file, a stuck subtask it never saw attempted, and
a plan it cannot read, cannot match or cannot write.
"""

from __future__ import annotations

import builtins
import json

import pytest
from services import recovery as recovery_module
from services.recovery import RecoveryManager


@pytest.fixture
def manager(tmp_path) -> RecoveryManager:
    return RecoveryManager(tmp_path / "spec", tmp_path)


def _plan(manager: RecoveryManager, *ids: str) -> None:
    plan = {"phases": [{"subtasks": [{"id": i, "status": "pending"} for i in ids]}]}
    (manager.spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def _plan_status(manager: RecoveryManager) -> dict:
    plan = json.loads(
        (manager.spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )
    return {s["id"]: s["status"] for p in plan["phases"] for s in p["subtasks"]}


def test_a_corrupt_attempt_history_starts_over(manager):
    manager.attempt_history_file.write_text("{broken", encoding="utf-8")

    assert manager.get_attempt_count("s1") == 0
    assert (
        json.loads(manager.attempt_history_file.read_text(encoding="utf-8"))["subtasks"]
        == {}
    )


def test_a_corrupt_commit_record_starts_over(manager):
    manager.build_commits_file.write_bytes(b"\xff\xfe not utf-8")

    assert manager.get_last_good_commit() is None
    manager.record_good_commit("a" * 40, "s1")
    assert manager.get_last_good_commit() == "a" * 40


def test_a_subtask_stuck_before_any_attempt_is_listed_and_blocked(manager):
    _plan(manager, "s1", "s2")

    manager.mark_subtask_stuck("s1", "needs a Mac", kind="platform")
    manager.mark_subtask_stuck("s1", "needs a Mac", kind="platform")

    stuck = manager.get_stuck_subtasks()
    assert [(s["subtask_id"], s["attempt_count"]) for s in stuck] == [("s1", 0)]
    assert _plan_status(manager) == {"s1": "blocked", "s2": "pending"}


def test_a_plan_without_the_subtask_is_left_alone(manager):
    _plan(manager, "other")
    before = (manager.spec_dir / "implementation_plan.json").read_text(encoding="utf-8")

    manager.mark_subtask_stuck("s1", "gone")

    after = (manager.spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    assert after == before


def test_an_unreadable_plan_does_not_stop_the_stuck_record(manager):
    (manager.spec_dir / "implementation_plan.json").write_text(
        "{not json", encoding="utf-8"
    )

    manager.mark_subtask_stuck("s1", "loops")

    assert [s["subtask_id"] for s in manager.get_stuck_subtasks()] == ["s1"]


def test_a_plan_that_cannot_be_written_does_not_stop_the_stuck_record(
    manager, monkeypatch
):
    _plan(manager, "s1")
    plan_file = manager.spec_dir / "implementation_plan.json"
    real_open = builtins.open

    def guarded(path, mode="r", *args, **kwargs):
        if str(path) == str(plan_file) and "w" in mode:
            raise PermissionError("plan locked")
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(recovery_module, "open", guarded, raising=False)

    manager.mark_subtask_stuck("s1", "loops")

    assert [s["subtask_id"] for s in manager.get_stuck_subtasks()] == ["s1"]
    assert _plan_status(manager) == {"s1": "pending"}


def test_hints_quote_each_error_and_skip_an_attempt_without_one(manager):
    manager.record_attempt("s1", 1, False, "first way", "ImportError: x")
    manager.record_attempt("s1", 2, True, "second way")

    hints = manager.get_recovery_hints("s1")

    assert hints[:4] == [
        "Previous attempts: 2",
        "Attempt 1: first way - FAILED",
        "  Error: ImportError: x",
        "Attempt 2: second way - SUCCESS",
    ]
    assert any("DIFFERENT approach" in h for h in hints)


def test_a_first_attempt_is_told_so(manager):
    assert manager.get_recovery_hints("s1") == [
        "This is the first attempt at this subtask"
    ]


def test_one_earlier_attempt_gets_no_change_of_approach_warning(manager):
    manager.record_attempt("s1", 1, False, "only way", None)

    assert manager.get_recovery_hints("s1") == [
        "Previous attempts: 1",
        "Attempt 1: only way - FAILED",
    ]
