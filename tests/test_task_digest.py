"""The digest of a long task on the notification channels (lot 6, P1).

Off unless asked and unless a channel is configured; the first digest comes
one interval after the build started; a build resumed after a restart waits
for the rest of the interval; the digest says what moved, what runs and what
is blocked, from the task's files only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "backend"))

from services.notifications import digest as digest_mod  # noqa: E402
from services.notifications.digest import (  # noqa: E402
    DIGEST_ENV,
    _Heartbeat,
    build_digest,
    digest_interval_seconds,
    render_digest,
    start_digest_heartbeat,
)
from services.notifications.models import (  # noqa: E402
    ChannelConfig,
    NotificationChannel,
)
from services.notifications.service import NotificationService  # noqa: E402

HOUR = 3600.0


def _plan(spec: Path, statuses: list[str], **extra) -> None:
    subtasks = [
        {"id": f"s{i}", "description": f"Subtask {i}", "status": s}
        for i, s in enumerate(statuses, start=1)
    ]
    for sub in subtasks:
        if sub["status"] == "blocked":
            sub["blocked_reason"] = "Run the iOS build on a Mac"
    plan = {"feature": "Invoices in PDF", "phases": [{"subtasks": subtasks}], **extra}
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def spec(tmp_path: Path) -> Path:
    folder = tmp_path / "001-invoices"
    folder.mkdir()
    return folder


class Clock:
    def __init__(self, now: float = 1_000_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def sent(monkeypatch):
    calls: list[tuple[str, dict]] = []

    def post(url: str, payload: dict):
        calls.append((url, payload))
        return True, 200, None

    monkeypatch.setattr(digest_mod, "post_json", post)
    return calls


def _service(*channels: NotificationChannel) -> NotificationService:
    return NotificationService(
        [ChannelConfig(c, f"https://hooks.example.com/{c.value}") for c in channels]
    )


def test_off_unless_asked_and_unless_a_channel_is_configured(spec, monkeypatch):
    monkeypatch.delenv(DIGEST_ENV, raising=False)
    assert digest_interval_seconds() is None
    assert start_digest_heartbeat(spec, spec) is None
    monkeypatch.setenv(DIGEST_ENV, "not-a-number")
    assert digest_interval_seconds() is None
    monkeypatch.setenv(DIGEST_ENV, "0")
    assert digest_interval_seconds() is None
    monkeypatch.setenv(DIGEST_ENV, "0.01")
    assert digest_interval_seconds() == 0.25 * HOUR
    monkeypatch.setenv(DIGEST_ENV, "4")
    for key in ("SLACK_NOTIFICATIONS_ENABLED", "TEAMS_NOTIFICATIONS_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    assert start_digest_heartbeat(spec, spec) is None  # no channel


def test_the_digest_says_what_moved_runs_and_blocks(spec):
    _plan(
        spec,
        ["completed", "completed", "in_progress", "blocked", "pending"],
        qa_signoff={"status": "rejected", "qa_session": 2},
    )
    digest = build_digest(spec)
    assert (digest.done, digest.total) == (2, 5)
    text = render_digest(digest, 26 * HOUR + 5 * 60, moved=True)
    assert "Invoices in PDF" in text and "1 d 2 h" in text
    assert "2/5" in text
    assert "Running: Subtask 3" in text
    assert "Subtask 4 (Run the iOS build on a Mac)" in text
    assert "QA: pass 2, rejected" in text
    assert "No subtask moved" not in text
    assert "No subtask moved" in render_digest(digest, HOUR, moved=False)


def test_first_digest_one_interval_after_the_start_then_each_interval(spec, sent):
    _plan(spec, ["completed", "pending"])
    clock = Clock()
    beat = _Heartbeat(spec, 4 * HOUR, _service(NotificationChannel.SLACK), clock)
    assert beat.due_in() == 4 * HOUR
    clock.now += 4 * HOUR
    assert beat.due_in() == 0
    assert beat.tick()
    [(url, payload)] = sent
    assert url.endswith("/slack") and "1/2" in payload["text"]
    assert beat.due_in() == 4 * HOUR


def test_a_resumed_build_waits_for_the_rest_of_the_interval(spec, sent):
    _plan(spec, ["pending"])
    clock = Clock()
    first = _Heartbeat(spec, 4 * HOUR, _service(NotificationChannel.SLACK), clock)
    first.due_in()
    clock.now += 4 * HOUR
    first.tick()
    clock.now += 1 * HOUR  # the app restarts and the build resumes
    again = _Heartbeat(spec, 4 * HOUR, _service(NotificationChannel.SLACK), clock)
    assert again.due_in() == 3 * HOUR
    assert len(sent) == 1


def test_a_webhook_gets_the_fields_and_nothing_moved_is_said(spec, sent):
    _plan(spec, ["in_progress"])
    clock = Clock()
    beat = _Heartbeat(spec, HOUR, _service(NotificationChannel.WEBHOOK), clock)
    beat.due_in()
    clock.now += HOUR
    beat.tick()
    clock.now += HOUR
    beat.tick()
    first, second = (p for _, p in sent)
    assert first["event"] == "task_digest" and first["subtasks_total"] == 1
    assert "No subtask moved" not in first["message"]
    assert "No subtask moved" in second["message"]


def test_a_task_without_a_plan_yet(spec):
    text = render_digest(build_digest(spec), 30 * 60, moved=True)
    assert "001-invoices" in text and "No plan yet" in text and "30 min" in text


def test_french(spec, monkeypatch):
    monkeypatch.setenv("APP_LANGUAGE", "fr")
    _plan(spec, ["completed"])
    text = render_digest(build_digest(spec), 2 * HOUR, moved=False)
    assert "Sous-tâches : 1/1 terminées" in text
    assert "Aucune sous-tâche" in text


def test_started_when_asked_and_a_channel_is_there(spec, monkeypatch):
    monkeypatch.setenv(DIGEST_ENV, "6")
    monkeypatch.setenv("SLACK_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.com/slack")
    stop = start_digest_heartbeat(spec, spec)
    assert stop is not None
    stop.set()
    state = json.loads(
        (spec / "memory" / "digest_state.json").read_text(encoding="utf-8")
    )
    assert isinstance(state["started_at"], float)


def test_the_project_env_file_is_read_too(spec, monkeypatch):
    monkeypatch.delenv(DIGEST_ENV, raising=False)
    (spec / ".workpilot").mkdir()
    (spec / ".workpilot" / ".env").write_text(f"{DIGEST_ENV}=2\n", encoding="utf-8")
    assert digest_interval_seconds(spec) == 2 * HOUR
