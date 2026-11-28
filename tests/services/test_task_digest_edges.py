"""The task digest when its inputs or its folder misbehave.

`tests/test_task_digest.py` pins what a digest says and when it goes out;
these tests pin what happens around a plan that is not well formed, a
channel that refuses, and a spec folder that cannot be written.
"""

from __future__ import annotations

import json

import pytest
from services.notifications import digest as digest_mod
from services.notifications.digest import (
    DIGEST_ENV,
    _Heartbeat,
    build_digest,
    start_digest_heartbeat,
)
from services.notifications.models import ChannelConfig, NotificationChannel
from services.notifications.service import NotificationService


@pytest.fixture
def spec(tmp_path):
    folder = tmp_path / "002-reports"
    folder.mkdir()
    return folder


def _service() -> NotificationService:
    return NotificationService(
        [ChannelConfig(NotificationChannel.SLACK, "https://hooks.example.com/s")]
    )


class _Stop:
    """A stop event that answers `wait` from a script, without waiting."""

    def __init__(self, *answers: bool) -> None:
        self.answers = list(answers)
        self.waits: list[float] = []

    def wait(self, seconds: float) -> bool:
        self.waits.append(seconds)
        return self.answers.pop(0)


def test_phases_and_subtasks_that_are_not_objects_are_skipped(spec):
    plan = {
        "phases": [
            "not a phase",
            {"subtasks": ["not a subtask", {"id": "s1", "status": "completed"}]},
        ]
    }
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")

    digest = build_digest(spec)

    assert (digest.done, digest.total) == (1, 1)


def test_a_digest_no_channel_accepts_is_logged(spec, monkeypatch, caplog):
    monkeypatch.setattr(
        digest_mod, "post_json", lambda url, payload: (False, 500, "HTTP 500")
    )
    beat = _Heartbeat(spec, 3600.0, _service(), clock=lambda: 1000.0)

    assert beat.tick() is False
    assert "no channel accepted the digest of 002-reports" in caplog.text


def test_a_send_that_fails_on_disk_waits_a_minute_then_goes_on(spec, caplog):
    stop = _Stop(False, False, True)
    beat = _Heartbeat(spec, 3600.0, _service(), clock=lambda: 1000.0, stop=stop)
    ticks = []

    def tick():
        ticks.append(1)
        raise OSError("disk full")

    beat.tick = tick

    beat.run()

    assert ticks == [1]
    assert stop.waits[1] == 60
    assert "could not send: disk full" in caplog.text


def test_a_stop_during_the_minute_after_a_failure_ends_the_loop(spec):
    stop = _Stop(False, True)
    beat = _Heartbeat(spec, 3600.0, _service(), clock=lambda: 1000.0, stop=stop)

    def tick():
        raise OSError("disk full")

    beat.tick = tick

    beat.run()

    assert stop.waits[1:] == [60]
    assert stop.answers == []


def test_no_digest_when_the_spec_folder_cannot_be_written(spec, monkeypatch, caplog):
    monkeypatch.setenv(DIGEST_ENV, "6")
    monkeypatch.setenv("SLACK_NOTIFICATIONS_ENABLED", "true")
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.com/slack")
    (spec / "memory").write_text("a file where the folder goes", encoding="utf-8")

    assert start_digest_heartbeat(spec, spec) is None
    assert "the spec folder is not writable" in caplog.text
