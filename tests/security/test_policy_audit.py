"""security.policy_audit: every decision of the policy, bounded, and never through a link."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from security import policy_audit
from security.policy_audit import (
    AUDIT_NAME,
    log_path,
    metrics,
    read_events,
    record,
    task_of,
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    return root


def test_a_decision_is_one_line_with_who_what_and_why(project: Path, monkeypatch):
    monkeypatch.setattr(policy_audit.getpass, "getuser", lambda: "dev")
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
    event = record(
        project,
        decision="deny",
        tool="Write",
        target={"kind": "file", "key": "file:db/1.sql", "summary": "db/1.sql"},
        rules=["files.forbidden:**/migrations/**"],
        reason="token=sk-test-00000000000000000000 refused",
        task="007-db",
        model="gpt-5",
        now=datetime(2026, 6, 1, 8, 0, tzinfo=UTC),
    )
    assert event is not None
    [line] = (
        (project / ".workpilot" / AUDIT_NAME).read_text(encoding="utf-8").splitlines()
    )
    stored = json.loads(line)
    assert stored == event
    assert stored["at"] == "2026-06-01T08:00:00+00:00"
    assert stored["user"] == "dev"
    assert stored["provider"] == "openai"
    assert stored["model"] == "gpt-5"
    assert stored["target"] == "db/1.sql" and stored["targetKind"] == "file"
    assert "sk-test" not in stored["reason"]


def test_what_is_not_a_plain_name_is_left_out(project: Path, monkeypatch):
    def no_user() -> str:
        raise OSError("no user")

    monkeypatch.setattr(policy_audit.getpass, "getuser", no_user)
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    event = record(
        project,
        decision="budget_exceeded",
        tool="rm -rf /",
        target={"kind": "elsewhere", "summary": ""},
        task="../x y",
        rules=["", "budget.max_tokens_per_hour"],
    )
    assert event is not None
    assert event["user"] is None
    assert event["tool"] is None
    assert event["task"] is None
    assert event["provider"] is None
    assert event["targetKind"] is None and event["target"] is None
    assert event["rules"] == ["budget.max_tokens_per_hour"]
    assert event["reason"] is None


def test_an_unknown_decision_is_a_bug(project: Path):
    with pytest.raises(ValueError, match="unknown policy decision"):
        record(project, decision="maybe")


def test_a_linked_folder_is_refused(project: Path, tmp_path: Path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (project / ".workpilot").symlink_to(elsewhere, target_is_directory=True)
    assert record(project, decision="deny") is None
    assert log_path(project) is None
    assert list(elsewhere.iterdir()) == []
    assert read_events(project) == []


def test_a_linked_log_is_refused(project: Path, tmp_path: Path):
    target = tmp_path / "victim.txt"
    target.write_text("keep\n", encoding="utf-8")
    (project / ".workpilot").mkdir()
    (project / ".workpilot" / AUDIT_NAME).symlink_to(target)
    assert record(project, decision="deny") is None
    assert target.read_text(encoding="utf-8") == "keep\n"


def test_a_project_that_is_not_a_folder_has_no_log(tmp_path: Path):
    not_a_folder = tmp_path / "file"
    not_a_folder.write_text("", encoding="utf-8")
    assert log_path(not_a_folder, create=True) is None
    assert record(not_a_folder, decision="deny") is None


def test_a_log_that_cannot_be_opened_is_skipped(project: Path):
    (project / ".workpilot" / AUDIT_NAME).mkdir(parents=True)
    assert record(project, decision="deny") is None


def test_the_log_is_bounded(project: Path, monkeypatch):
    monkeypatch.setattr(policy_audit, "MAX_BYTES", 2000)
    monkeypatch.setattr(policy_audit, "KEEP_LINES", 3)
    for index in range(12):
        record(project, decision="deny", reason=f"call {index}")
    lines = (
        (project / ".workpilot" / AUDIT_NAME).read_text(encoding="utf-8").splitlines()
    )
    assert len(lines) < 12
    assert json.loads(lines[-1])["reason"] == "call 11"


def test_events_are_read_newest_first_and_garbage_skipped(project: Path):
    for decision in ("deny", "review"):
        record(project, decision=decision)
    with (project / ".workpilot" / AUDIT_NAME).open("a", encoding="utf-8") as handle:
        handle.write("not json\n")
        handle.write(json.dumps({"decision": "forged"}) + "\n")
        handle.write("[1]\n")
    assert [e["decision"] for e in read_events(project)] == ["review", "deny"]
    assert [e["decision"] for e in read_events(project, limit=4)] == ["review"]
    assert read_events(project, limit=0) == []


def test_nothing_to_read_is_no_event(project: Path):
    assert read_events(project) == []


def test_an_oversized_log_is_not_read(project: Path, monkeypatch):
    record(project, decision="deny")
    monkeypatch.setattr(policy_audit, "MAX_BYTES", 10)
    assert read_events(project) == []


def test_an_unreadable_log_is_no_event(project: Path, monkeypatch):
    record(project, decision="deny")

    def broken(self, *args, **kwargs):
        raise OSError("gone")

    monkeypatch.setattr(Path, "read_text", broken)
    assert read_events(project) == []


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="no O_NOFOLLOW here")
def test_the_file_is_private(project: Path):
    record(project, decision="deny")
    mode = (project / ".workpilot" / AUDIT_NAME).stat().st_mode & 0o777
    assert mode & 0o077 == 0


@pytest.mark.parametrize(
    ("root", "expected"),
    [
        (None, None),
        (Path("/p/.workpilot/worktrees/tasks/007-db"), "007-db"),
        (Path("/p/src"), None),
    ],
)
def test_the_task_comes_from_the_worktree(root, expected):
    assert task_of(root) == expected


def test_the_counts_cover_the_day_and_the_week(project: Path):
    now = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)
    for decision, hours in (
        ("deny", 1),
        ("outside_hours", 5),
        ("invalid_policy", 23),
        ("budget_exceeded", 30),  # older than a day
        ("review", 1),  # not a stop
        ("tool_loop", 2),
        ("tool_loop", 24 * 6),
        ("tool_loop", 24 * 8),  # older than a week
    ):
        record(project, decision=decision, now=now - timedelta(hours=hours))
    assert metrics(project, now) == {"blocked24h": 3, "breakerTrips7d": 2}


def test_a_line_without_a_date_is_not_counted(project: Path):
    path = project / ".workpilot" / AUDIT_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        {"decision": "deny", "at": "yesterday"},
        {"decision": "deny", "at": "2026-11-21T11:00:00"},
    ]
    path.write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
    now = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)
    assert metrics(project, now) == {"blocked24h": 1, "breakerTrips7d": 0}
    assert metrics(project / "none") == {"blocked24h": 0, "breakerTrips7d": 0}
