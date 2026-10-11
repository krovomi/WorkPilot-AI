"""A merge is published once, and each feature subscribes (audit lot L7, F14).

What has to hold:

* the CLI that merges publishes **one** `MergeEvent` on success and none on
  failure;
* every declared subscriber resolves to a callable, and they are told in the
  declared order: usage counters, learning loop, brain, design-system knowledge;
* a subscriber that fails does not stop the others, nor fail the merge.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core import merge_event  # noqa: E402
from core.merge_event import MergeEvent, publish  # noqa: E402


def test_every_subscriber_resolves():
    for subscriber in merge_event.SUBSCRIBERS:
        assert callable(merge_event._resolve(subscriber)), subscriber


def test_the_four_stores_are_subscribed_in_order():
    assert merge_event.SUBSCRIBERS[:4] == [
        "core.usage_tracker:on_merge",
        "learning_loop.observe:on_merge",
        "brain.learn:on_merge",
        "uiux.knowledge:on_merge",
    ]


def test_a_failing_subscriber_does_not_stop_the_others(monkeypatch, tmp_path):
    heard: list[str] = []

    def broken(event):
        raise RuntimeError("disk full")

    monkeypatch.setattr(
        merge_event,
        "SUBSCRIBERS",
        [broken, lambda e: heard.append(e.spec_name)],
    )
    failed = publish(MergeEvent(tmp_path, "001-login"))
    assert heard == ["001-login"]
    assert failed == [broken.__qualname__]


def test_usage_counters_hear_a_manual_merge(tmp_path):
    from core.usage_tracker import on_merge

    on_merge(MergeEvent(tmp_path, "001-login"))
    snapshot = json.loads(
        (tmp_path / ".workpilot" / "dashboard_snapshot.json").read_text("utf-8")
    )
    assert snapshot["merge_manual_count"] == 1
    assert snapshot["merge_auto_count"] == 0


@pytest.mark.parametrize("merged", [True, False])
def test_the_cli_publishes_once_on_success_only(monkeypatch, tmp_path, merged):
    from cli import workspace_commands

    published: list[MergeEvent] = []
    monkeypatch.setattr(
        workspace_commands, "merge_existing_build", lambda *a, **k: merged
    )
    monkeypatch.setattr(merge_event, "publish", published.append)

    assert workspace_commands.handle_merge_command(tmp_path, "001-login") is merged
    assert published == ([MergeEvent(tmp_path, "001-login")] if merged else [])
