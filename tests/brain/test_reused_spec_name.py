"""A task that reuses a deleted task's spec name does not inherit its sessions.

Spec folders are numbered, and a deleted task's number goes to the next one:
the same title then gives the same name (``003-test``). Session notes name
their task by that folder, so the new task read the old one's
"recommendations for the next session" as its own history, and a planner was
handed a November task's ``toto.txt`` subtask.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.project_memory import ProjectMemory
from brain.spec_birth import born_at, parse_moment, predates


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return root


def _spec(tmp_path: Path, created: datetime) -> Path:
    spec_dir = tmp_path / "dotnet" / ".workpilot" / "specs" / "003-test"
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"created_at": created.isoformat(), "phases": []}), "utf-8"
    )
    stamp = created.timestamp()
    for child in spec_dir.iterdir():
        os.utime(child, (stamp, stamp))
    return spec_dir


def test_the_sessions_of_an_earlier_task_with_the_same_name_are_not_recalled(
    vault, tmp_path
) -> None:
    old_day = datetime(2026, 11, 22, 16, 10, tzinfo=UTC)
    old = ProjectMemory(_spec(tmp_path, old_day))
    old.record_session(
        1,
        {
            "timestamp": (old_day + timedelta(minutes=5)).isoformat(),
            "subtasks_completed": ["subtask-1-create-toto"],
            "recommendations_for_next_session": ["Write ok in toto.txt"],
        },
    )
    old.flush()
    # The task is deleted, and the next one takes its folder name.
    for child in old.spec_dir.iterdir():
        child.unlink()
    new_day = datetime(2026, 11, 28, 17, 30, tzinfo=UTC)
    new = ProjectMemory(_spec(tmp_path, new_day))

    assert new.load_sessions() == []

    new.record_session(
        1,
        {
            "timestamp": (new_day + timedelta(minutes=2)).isoformat(),
            "recommendations_for_next_session": ["Plan the test project"],
        },
    )
    new.flush()
    [session] = new.load_sessions()
    assert session["recommendations_for_next_session"] == ["Plan the test project"]
    # A person's view of the whole project still lists both.
    assert len(new.load_sessions(spec_only=False)) == 2


def test_the_birth_is_the_earliest_thing_the_folder_records(tmp_path) -> None:
    created = datetime(2026, 11, 28, 17, 30, tzinfo=UTC)
    spec_dir = _spec(tmp_path, created)
    (spec_dir / "status_history.json").write_text(
        json.dumps({"version": 1, "entries": [{"at": "2026-11-28T17:29:00Z"}]}),
        "utf-8",
    )
    later = (created + timedelta(hours=1)).timestamp()
    os.utime(spec_dir / "status_history.json", (later, later))

    assert born_at(spec_dir) == datetime(2026, 11, 28, 17, 29, tzinfo=UTC)


def test_an_unknown_date_keeps_the_note(tmp_path) -> None:
    born = datetime(2026, 11, 28, tzinfo=UTC)
    assert not predates(None, born)
    assert not predates("not a date", born)
    assert not predates("2026-11-01T00:00:00Z", None)
    assert born_at(tmp_path / "missing") is None
    assert predates("2026-11-01T00:00:00", born)  # naive reads as UTC
    # A minute of slack around the start.
    assert not predates("2026-11-27T23:59:30+00:00", born)
    assert parse_moment("2026-11-28T10:00:00Z") == datetime(
        2026, 11, 28, 10, tzinfo=UTC
    )
