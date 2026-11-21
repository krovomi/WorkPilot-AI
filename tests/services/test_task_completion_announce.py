"""A finished task is announced on the channels and to the hooks, and never fails.

The notification service and the hooks service are the real ones: the
channel is configured in the project's `.workpilot/.env`, the hooks live
under a temporary WORKPILOT_DATA_DIR. Only the POST is replaced.
"""

from __future__ import annotations

import pytest
from services import task_completion_service as completion
from services.hooks.hook_service import HookService
from services.notifications import PRReadyNotification, channels

NOTIF = PRReadyNotification(task_title="Invoices in PDF", pr_url="https://pr.example/7")


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(HookService, "_instance", None)
    root = tmp_path / "project"
    (root / ".workpilot").mkdir(parents=True)
    (root / ".workpilot" / ".env").write_text(
        "SLACK_NOTIFICATIONS_ENABLED=true\n"
        "SLACK_WEBHOOK_URL=https://hooks.example.com/slack\n",
        encoding="utf-8",
    )
    return root


def test_the_channels_and_the_pr_opened_hooks_both_hear_of_it(project, monkeypatch):
    posted = []
    monkeypatch.setattr(
        channels,
        "post_json",
        lambda url, payload: posted.append(url) or (True, 200, None),
    )
    hook = HookService.get_instance().create_hook(
        {
            "name": "on PR",
            "triggers": [{"type": "pr_opened"}],
            "actions": [{"type": "log_event"}],
        }
    )

    completion._announce_pr_ready(NOTIF, project)

    assert posted == ["https://hooks.example.com/slack"]
    execution = HookService.get_instance().get_executions(hook_id=hook["id"])[0]
    assert execution["trigger_event"]["data"]["pr_url"] == "https://pr.example/7"
    assert execution["trigger_event"]["source"] == "task_completion"


def test_a_project_without_channels_still_tells_the_hooks(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(HookService, "_instance", None)
    hook = HookService.get_instance().create_hook(
        {"name": "on PR", "triggers": [{"type": "pr_opened"}], "actions": []}
    )

    completion._announce_pr_ready(NOTIF, tmp_path)

    assert len(HookService.get_instance().get_executions(hook_id=hook["id"])) == 1


def test_failures_on_both_sides_are_logged_not_raised(project, monkeypatch, caplog):
    def no_channels(project_path):
        raise OSError("env unreadable")

    def no_hooks(cls):
        raise RuntimeError("hooks store broken")

    monkeypatch.setattr(completion.NotificationService, "from_env", no_channels)
    monkeypatch.setattr(HookService, "get_instance", classmethod(no_hooks))

    completion._announce_pr_ready(NOTIF, project)

    assert "Failed to send PR-ready notification: env unreadable" in caplog.text
    assert "Failed to emit pr_opened hook event: hooks store broken" in caplog.text
