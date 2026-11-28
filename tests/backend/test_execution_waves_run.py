"""The run of "Execute in optimal order" on a server project: its state in the
clone (``shared_features.waves.run_store``) and its steps
(``shared_features.waves.execution``).

The state is rebuilt field by field; anything incoherent is refused, a link
is never followed, a file swapped or oversized is ignored, and the history
keeps counts only.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta

import pytest
from foundation.platform import is_windows
from shared_features.waves import execution, run_store
from shared_features.waves.execution import CardState

NOW = datetime(2026, 11, 20, 12, tzinfo=UTC)


def state(**extra) -> dict:
    value = {
        "projectId": "p1",
        "waves": [["001-a", "002-b"], ["003-c"]],
        "current": 0,
        "advanceWhen": "merged",
        "maxParallel": 2,
        "started": [],
    }
    value.update(extra)
    return value


# -- validation ----------------------------------------------------------------


def test_a_coherent_state_is_rebuilt_field_by_field():
    checked = run_store.validate_run(
        state(
            extra="dropped",
            avoided={"conflicts": 1, "risk": 3},
            startedBy="u1",
            failures={"001-a": "claimed"},
            options={"tolerance": 1, "maxParallel": 2},
        ),
        "p1",
    )
    assert "extra" not in checked
    assert checked["avoided"] == {"conflicts": 1, "risk": 3}
    assert checked["failures"] == {"001-a": "claimed"}
    assert checked["options"]["tolerance"] == 1 and checked["startedBy"] == "u1"


@pytest.mark.parametrize(
    "change",
    [
        {"projectId": "p2"},
        {"waves": []},
        {"waves": "x"},
        {"waves": [[]]},
        {"waves": [["../etc"]]},
        {"waves": [["001-a"], ["001-a"]], "started": []},
        {"waves": [[f"{i:03d}-x" for i in range(201)]]},
        {"current": 3},
        {"current": -1},
        {"current": True},
        {"advanceWhen": "whenever"},
        {"maxParallel": 0},
        {"maxParallel": 33},
        {"started": "001-a"},
        {"started": ["009-z"]},
        {"started": ["001-a", "001-a"]},
        {"avoided": []},
        {"avoided": {"conflicts": -1, "risk": 0}},
        {"startedBy": ""},
        {"startedBy": 4},
        {"failures": []},
        {"failures": {"001-a": "because I said so"}},
        {"failures": {"009-z": "claimed"}},
        {"options": {"tolerance": -4}},
    ],
)
def test_an_incoherent_state_is_refused(change):
    assert run_store.validate_run(state(**change), "p1") is None


def test_a_state_that_is_not_an_object_is_refused():
    assert run_store.validate_run(["x"], "p1") is None


# -- the files in the clone -------------------------------------------------------


def test_save_load_and_end_a_run(tmp_path):
    clone = tmp_path / "clone"
    clone.mkdir()
    known = {"001-a", "002-b", "003-c"}
    assert run_store.load_run(clone, "p1", known) == (None, False)
    saved = run_store.save_run(clone, state(avoided={"conflicts": 2, "risk": 5}), NOW)
    assert saved["savedAt"] == NOW.isoformat()
    path = clone / ".workpilot" / run_store.RUN_FILE
    # Windows keeps no owner-only bits: a file there reads 0o666 whatever the mode.
    assert oct(path.stat().st_mode & 0o777) == ("0o666" if is_windows() else "0o600")
    loaded, ignored = run_store.load_run(clone, "p1", known)
    assert not ignored and loaded["waves"] == saved["waves"]
    # A run naming a card the clone no longer has is ignored, and left alone.
    assert run_store.load_run(clone, "p1", {"001-a"}) == (None, True)
    assert path.exists()
    with pytest.raises(ValueError):
        run_store.save_run(clone, state(current=9), NOW)
    run_store.end_run(clone, loaded, "done", NOW)
    assert not path.exists()
    history = run_store.load_history(clone)
    assert history == {
        "records": [
            {
                "finishedAt": NOW.isoformat(),
                "outcome": "done",
                "waves": 2,
                "tasks": 3,
                "started": 0,
                "conflictsAvoided": 2,
                "riskAvoided": 5,
            }
        ],
        "ignored": False,
    }
    with pytest.raises(ValueError):
        run_store.end_run(clone, loaded, "abandoned", NOW)
    run_store.clear_run(clone)  # nothing to clear: no error
    run_store.clear_run(tmp_path / "no-workpilot")


def test_the_history_keeps_the_last_hundred(tmp_path, monkeypatch):
    monkeypatch.setattr(run_store, "MAX_RECORDS", 3)
    for i in range(5):
        run_store.end_run(tmp_path, state(), "stopped", NOW + timedelta(minutes=i))
    records = run_store.load_history(tmp_path)["records"]
    assert len(records) == 3
    assert records[0]["finishedAt"] == (NOW + timedelta(minutes=4)).isoformat()


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        json.dumps({"version": 2, "records": []}),
        json.dumps({"version": 1, "records": "x"}),
        json.dumps({"version": 1, "records": [{"outcome": "done"}]}),
        json.dumps({"version": 1, "records": ["x"]}),
        json.dumps(["x"]),
        "\udcff",
    ],
)
def test_a_history_that_cannot_be_read_is_ignored(tmp_path, content):
    folder = tmp_path / ".workpilot"
    folder.mkdir()
    (folder / run_store.HISTORY_FILE).write_bytes(
        content.encode("utf-8", "surrogateescape")
    )
    assert run_store.load_history(tmp_path) == {"records": [], "ignored": True}


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        json.dumps({"version": 2, **state(), "savedAt": NOW.isoformat()}),
        json.dumps({"version": 1, **state(), "savedAt": "yesterday"}),
        json.dumps({"version": 1, **state()}),
        json.dumps({"version": 1, **state(current=7), "savedAt": NOW.isoformat()}),
        json.dumps(["x"]),
    ],
)
def test_a_run_file_that_cannot_be_used_is_ignored(tmp_path, content):
    folder = tmp_path / ".workpilot"
    folder.mkdir()
    (folder / run_store.RUN_FILE).write_text(content, encoding="utf-8")
    assert run_store.load_run(tmp_path, "p1", {"001-a", "002-b", "003-c"}) == (
        None,
        True,
    )


def test_links_are_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / run_store.RUN_FILE).write_text("{}", encoding="utf-8")
    clone = tmp_path / "clone"
    clone.mkdir()
    os.symlink(outside, clone / ".workpilot")
    assert run_store.load_run(clone, "p1", set()) == (None, True)
    with pytest.raises(run_store.StoreRefused):
        run_store.save_run(clone, state(), NOW)
    other = tmp_path / "other"
    (other / ".workpilot").mkdir(parents=True)
    os.symlink(outside / run_store.RUN_FILE, other / ".workpilot" / run_store.RUN_FILE)
    assert run_store.load_run(other, "p1", set()) == (None, True)
    with pytest.raises(run_store.StoreRefused):
        run_store.save_run(other, state(), NOW)
    run_store.clear_run(other)  # the link itself goes, never its target
    assert (outside / run_store.RUN_FILE).exists()
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / ".workpilot").write_text("a file", encoding="utf-8")
    with pytest.raises(run_store.StoreRefused):
        run_store.workpilot_dir(plain, False)


def test_a_workpilot_folder_resolving_elsewhere_is_refused(tmp_path, monkeypatch):
    (tmp_path / ".workpilot").mkdir()
    real = os.path.realpath
    monkeypatch.setattr(
        run_store.os.path,
        "realpath",
        lambda p: (
            str(tmp_path / "elsewhere") if str(p).endswith(".workpilot") else real(p)
        ),
    )
    with pytest.raises(run_store.StoreRefused):
        run_store.workpilot_dir(tmp_path, False)


def test_oversized_or_swapped_files_are_refused(tmp_path, monkeypatch):
    folder = tmp_path / ".workpilot"
    folder.mkdir()
    target = folder / "x.json"
    target.write_text("12345", encoding="utf-8")
    with pytest.raises(run_store.StoreRefused):
        run_store.read_bounded(target, 4)
    assert run_store.read_bounded(target, 5) == "12345"
    real_fstat = os.fstat

    def swapped(fd):
        result = real_fstat(fd)
        return os.stat_result((result.st_mode, result.st_ino + 1, *tuple(result)[2:]))

    monkeypatch.setattr(run_store.os, "fstat", swapped)
    with pytest.raises(run_store.StoreRefused):
        run_store.read_bounded(target, 5)


def test_a_failed_write_leaves_no_temporary_file(tmp_path, monkeypatch):
    def refuse(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(run_store.os, "replace", refuse)
    with pytest.raises(OSError):
        run_store.save_run(tmp_path, state(), NOW)
    assert list((tmp_path / ".workpilot").iterdir()) == []


def test_the_sprint_counts_the_last_fourteen_days():
    def record(days: int, outcome: str) -> dict:
        return {
            "finishedAt": (NOW - timedelta(days=days)).isoformat(),
            "outcome": outcome,
            "waves": 2,
            "tasks": 3,
            "started": 3,
            "conflictsAvoided": 1,
            "riskAvoided": 2,
        }

    history = {"records": [record(1, "done"), record(3, "stopped"), record(20, "done")]}
    assert run_store.sprint_summary(history, NOW) == {
        "days": 14,
        "runs": 2,
        "stopped": 1,
        "conflictsAvoided": 2,
        "riskAvoided": 4,
        "started": 6,
        "lastFinishedAt": (NOW - timedelta(days=1)).isoformat(),
    }
    assert run_store.sprint_summary({"records": []}, NOW)["lastFinishedAt"] is None


def test_a_naive_date_is_read_as_utc():
    assert run_store._moment("2026-11-20T12:00:00") == NOW.isoformat()
    assert run_store._moment("x" * 65) is None


# -- steps ---------------------------------------------------------------------


def cards(**columns) -> dict[str, CardState]:
    return {name.replace("_", "-"): value for name, value in columns.items()}


def test_a_step_starts_what_fits_and_holds_what_waits():
    run = state(maxParallel=2)
    board = cards(
        **{
            "001_a": CardState("backlog"),
            "002_b": CardState("backlog", blocked_by=("009-z",)),
            "003_c": CardState("backlog"),
            "009_z": CardState("in_progress"),
        }
    )
    result = execution.step(run, board)
    assert result.promote == ["001-a"] and result.blocked == ["002-b"]
    assert not result.wave_settled
    # Room for none: a card of the project already runs, and one is queued.
    busy = {**board, "004-d": CardState("backlog", running=True)}
    assert execution.step(run, busy).promote == []


def test_a_blocker_done_archived_abandoned_missing_or_itself_holds_nothing():
    run = state(waves=[["001-a"]], maxParallel=4)
    for blocker in (
        CardState("done"),
        CardState("pr_created"),
        CardState("backlog", archived=True),
        CardState("backlog", abandoned=True),
    ):
        board = {"001-a": CardState("backlog", blocked_by=("002-b",)), "002-b": blocker}
        assert execution.step(run, board).promote == ["001-a"]
    alone = {"001-a": CardState("backlog", blocked_by=("001-a", "404-x"))}
    assert execution.step(run, alone).promote == ["001-a"]


def test_a_wave_settles_on_its_rule():
    merged = state(started=["001-a", "002-b"])
    board = {"001-a": CardState("done"), "002-b": CardState("human_review")}
    assert not execution.step(merged, board).wave_settled
    review = state(advanceWhen="review", started=["001-a", "002-b"])
    settled = execution.step(review, board)
    assert settled.wave_settled and not settled.finished
    # Started then back in the backlog with no run: it left the plan.
    left = {"001-a": CardState("done"), "002-b": CardState("backlog")}
    assert execution.step(merged, left).wave_settled
    queued = {"001-a": CardState("done"), "002-b": CardState("backlog", running=True)}
    assert not execution.step(merged, queued).wave_settled
    archived = {"001-a": CardState("done"), "002-b": CardState("queue", archived=True)}
    assert execution.step(merged, archived).wave_settled
    last = state(current=1, started=["003-c"])
    assert execution.step(last, {"003-c": CardState("done")}).finished
    assert execution.step(state(current=2), {}).finished
