"""How long a server card's merge conflict took to resolve
(``shared_features.waves.conflict_times``), against real git repositories: a
failed merge run that git finds in conflict opens one entry per card, the
next merge run that succeeds closes it, entries are read back field by field
and bounded, the run store's refusals hold, and the summary is a median of
measured times.
"""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from shared_features.waves import conflict_times
from shared_features.waves.conflict_times import (
    MAX_ENTRIES,
    TIMES_FILE,
    load_times,
    merge_conflicts,
    note_conflict,
    note_merged,
    record_merge_run,
    resolution_summary,
    validate_entry,
)

T0 = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
T1 = T0 + timedelta(hours=2, minutes=30)


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        [
            "git",
            "-c",
            "user.name=Waves",
            "-c",
            "user.email=waves@example.test",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def commit(repo: Path, files: dict[str, str], message: str) -> None:
    for name, text in files.items():
        (repo / name).write_text(text, encoding="utf-8")
    git("add", *files, cwd=repo)
    git("commit", "-q", "-m", message, cwd=repo)


@pytest.fixture
def clone(tmp_path) -> Path:
    repo = tmp_path / "clone"
    repo.mkdir()
    git("init", "-q", "-b", "main", cwd=repo)
    commit(repo, {"app.py": "value = 1\n"}, "init")
    return repo


def workspace(clone: Path, card: str, text: str) -> Path:
    path = clone / ".workpilot" / "worktrees" / "tasks" / card
    git("worktree", "add", "-q", "-b", f"wp/{card}", str(path), "main", cwd=clone)
    commit(path, {"app.py": text}, card)
    return path


def entries(clone: Path) -> list[dict]:
    return load_times(clone)["entries"]


# -- entries -------------------------------------------------------------------


def test_an_entry_is_rebuilt_field_by_field():
    open_ = {"taskId": "001-a", "detectedAt": T0.isoformat(), "resolvedAt": None}
    assert validate_entry(open_) == open_
    assert validate_entry(
        {
            "taskId": "001-a",
            "detectedAt": "2026-11-20T09:00:00Z",
            "resolvedAt": T1.isoformat(),
        }
    ) == {"taskId": "001-a", "detectedAt": T0.isoformat(), "resolvedAt": T1.isoformat()}


@pytest.mark.parametrize(
    "raw",
    [
        [],
        {"taskId": "../x", "detectedAt": T0.isoformat(), "resolvedAt": None},
        {"taskId": "001-a", "detectedAt": "soon", "resolvedAt": None},
        {"taskId": "001-a", "detectedAt": T0.isoformat()},
        {"taskId": "001-a", "detectedAt": T0.isoformat(), "resolvedAt": "later"},
        {"taskId": "001-a", "detectedAt": T1.isoformat(), "resolvedAt": T0.isoformat()},
    ],
)
def test_an_ill_formed_entry_is_refused(raw):
    assert validate_entry(raw) is None


def test_one_open_entry_per_card_closed_by_the_next_merge(clone):
    assert load_times(clone) == {"entries": [], "ignored": False}
    note_merged(clone, "001-a", T1)  # no conflict: nothing written
    assert not (clone / ".workpilot" / TIMES_FILE).exists()
    note_conflict(clone, "001-a", T0)
    note_conflict(clone, "001-a", T1)  # still the same conflict: its first date stays
    note_conflict(clone, "002-b", T1)
    note_merged(clone, "001-a", T1)
    assert entries(clone) == [
        {"taskId": "002-b", "detectedAt": T1.isoformat(), "resolvedAt": None},
        {"taskId": "001-a", "detectedAt": T0.isoformat(), "resolvedAt": T1.isoformat()},
    ]


def test_a_resolution_is_never_before_its_conflict(clone):
    note_conflict(clone, "001-a", T1)
    note_merged(clone, "001-a", T0)
    assert entries(clone)[0]["resolvedAt"] == T1.isoformat()


def test_at_most_the_limit_newest_first(clone):
    for i in range(MAX_ENTRIES + 2):
        note_conflict(clone, f"{i:03d}-card", T0)
    kept = entries(clone)
    assert len(kept) == MAX_ENTRIES
    assert kept[0]["taskId"] == f"{MAX_ENTRIES + 1:03d}-card"


@pytest.mark.parametrize(
    "body",
    [
        "{",
        json.dumps({"version": 2, "entries": []}),
        json.dumps({"version": 1, "entries": {}}),
        json.dumps({"version": 1, "entries": [{"taskId": "x"}]}),
        json.dumps({"version": 1, "entries": [], "pad": "x" * (70 * 1024)}),
    ],
)
def test_an_unreadable_file_is_ignored_and_starts_again(clone, body):
    (clone / ".workpilot").mkdir()
    (clone / ".workpilot" / TIMES_FILE).write_text(body, encoding="utf-8")
    assert load_times(clone) == {"entries": [], "ignored": True}
    note_conflict(clone, "001-a", T0)
    assert load_times(clone)["ignored"] is False


def test_a_linked_file_is_refused_and_never_written_through(clone, tmp_path, caplog):
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps({"version": 1, "entries": []}), encoding="utf-8")
    (clone / ".workpilot").mkdir()
    (clone / ".workpilot" / TIMES_FILE).symlink_to(elsewhere)
    assert load_times(clone)["ignored"] is True
    record_merge_run(clone, "001-a", True, "main")  # nothing open: nothing to write
    workspace(clone, "001-a", "value = 2\n")
    commit(clone, {"app.py": "value = 3\n"}, "main moves")
    record_merge_run(clone, "001-a", False, "main", T0)
    assert "StoreRefused" in caplog.text
    assert json.loads(elsewhere.read_text(encoding="utf-8"))["entries"] == []


# -- the conflict, from git --------------------------------------------------------


def test_a_failed_merge_counts_only_when_git_finds_a_conflict(clone):
    # No workspace, or a base that is not a branch name: no conflict.
    assert merge_conflicts(clone, "001-a", "main") is False
    workspace(clone, "001-a", "value = 2\n")
    assert merge_conflicts(clone, "001-a", "-x") is False
    assert merge_conflicts(clone, "001-a", "a..b") is False
    assert merge_conflicts(clone, "001-a", "nowhere") is False
    # The base has not moved: the merge is clean, so the failure was something else.
    assert merge_conflicts(clone, "001-a", "main") is False
    record_merge_run(clone, "001-a", False, "main", T0)
    assert entries(clone) == []

    commit(clone, {"app.py": "value = 3\n"}, "main moves")
    assert merge_conflicts(clone, "001-a", "main") is True
    record_merge_run(clone, "001-a", False, "main", T0)
    record_merge_run(clone, "001-a", True, "main", T1)
    assert entries(clone) == [
        {"taskId": "001-a", "detectedAt": T0.isoformat(), "resolvedAt": T1.isoformat()}
    ]


def test_the_base_may_be_known_only_as_the_remote_s_branch(clone, tmp_path):
    workspace(clone, "001-a", "value = 2\n")
    commit(clone, {"app.py": "value = 3\n"}, "main moves")
    head = git("rev-parse", "main", cwd=clone).strip()
    git("update-ref", "refs/remotes/origin/release", head, cwd=clone)
    assert merge_conflicts(clone, "001-a", "release") is True


def test_a_merge_git_cannot_judge_is_no_conflict(clone, monkeypatch):
    workspace(clone, "001-a", "value = 2\n")
    commit(clone, {"app.py": "value = 3\n"}, "main moves")
    monkeypatch.setattr(conflict_times.git_reads, "trial_merge", lambda *a: None)
    assert merge_conflicts(clone, "001-a", "main") is False


def test_record_merge_run_uses_the_server_clock_by_default(clone):
    note_conflict(clone, "001-a", T0)
    record_merge_run(clone, "001-a", True, "main")
    assert entries(clone)[0]["resolvedAt"] is not None


# -- the summary ---------------------------------------------------------------------


def test_the_summary_is_the_median_of_measured_times_over_14_days():
    now = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)

    def resolved(days_ago: int, minutes: int) -> dict:
        end = now - timedelta(days=days_ago)
        return {
            "taskId": "001-a",
            "detectedAt": (end - timedelta(minutes=minutes)).isoformat(),
            "resolvedAt": end.isoformat(),
        }

    times = {
        "entries": [
            resolved(1, 10),
            resolved(2, 30),
            resolved(3, 20),
            resolved(20, 600),
            {"taskId": "002-b", "detectedAt": now.isoformat(), "resolvedAt": None},
        ],
        "ignored": False,
    }
    assert resolution_summary(times, now) == {
        "ignored": False,
        "resolved": 3,
        "medianSeconds": 1200.0,
        "open": 1,
    }
    assert resolution_summary({"entries": [], "ignored": True}, now) == {
        "ignored": True,
        "resolved": 0,
        "medianSeconds": None,
        "open": 0,
    }
