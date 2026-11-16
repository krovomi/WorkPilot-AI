"""agents.policy_watch: the hours and the token budget of workpilot.policy.yaml, any provider."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from agents import iteration_guards
from agents.policy_watch import (
    BUDGET_REASON,
    HOURS_REASON,
    PolicyWatch,
    _identity,
    policy_pause_before_session,
    tokens_last_hour,
    verdict,
)
from agents.session_guards import SessionGuards
from foundation.build_signals import BuildPaused
from foundation.pause_state import read_pause_state
from security.guardrail_policy import load_policy
from security.policy_audit import read_events


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / ".workpilot").mkdir(parents=True)
    return root


@pytest.fixture
def spec(project: Path) -> Path:
    folder = project / ".workpilot" / "specs" / "001-x"
    folder.mkdir(parents=True)
    return folder


def _closed_window() -> str:
    now = datetime.now(UTC)
    minute = now.hour * 60 + now.minute
    start, end = (minute + 120) % 1440, (minute + 180) % 1440
    return f"{start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d}"


def _policy(project: Path, doc: dict) -> None:
    (project / "workpilot.policy.yaml").write_text(
        yaml.safe_dump(doc), encoding="utf-8"
    )


def _closed(project: Path) -> None:
    _policy(
        project, {"schedule": {"timezone": "UTC", "allowed_hours": [_closed_window()]}}
    )


def _usage(project: Path, *rows: tuple[int, datetime | None]) -> None:
    usages = [
        {
            "spec_id": "001-x",
            "cost": 0.0,
            "input_tokens": tokens,
            "output_tokens": 0,
            "timestamp": at.isoformat() if at else None,
        }
        for tokens, at in rows
    ]
    (project / ".workpilot" / "cost_data.json").write_text(
        json.dumps({"usages": usages}), encoding="utf-8"
    )


class FakeAgentClient:
    model = "gpt-5"

    def provider_name(self) -> str:
        return "openai"


def test_tokens_are_counted_over_the_last_hour(project: Path):
    now = datetime.now(UTC)
    _usage(
        project,
        (1500, now - timedelta(minutes=10)),
        (9000, now - timedelta(hours=2)),
        (7, None),
    )
    assert tokens_last_hour(project, now) == 1500


def test_no_policy_stops_nothing(project: Path, spec: Path):
    watch = PolicyWatch(spec, "coding")
    assert not watch.tripped
    assert verdict(project, None) is None
    assert policy_pause_before_session(spec, "coding") is None


def test_a_spec_outside_a_project_is_not_watched(tmp_path: Path):
    watch = PolicyWatch(tmp_path / "loose", "coding")
    assert watch.project is None and not watch.check()
    assert policy_pause_before_session(tmp_path / "loose", "coding") is None


def test_outside_the_hours_the_session_stops_at_once(project: Path, spec: Path):
    _closed(project)
    watch = PolicyWatch(spec, "coding", FakeAgentClient())
    assert watch.tripped
    state = read_pause_state(spec)
    assert state["reason"] == HOURS_REASON
    assert state["policy"]["timezone"] == "UTC"
    [event] = read_events(project)
    assert event["decision"] == "outside_hours"
    assert event["provider"] == "openai" and event["model"] == "gpt-5"
    assert event["task"] == "001-x"
    assert not watch.check()  # once


def test_the_hours_are_checked_at_each_tool_call(project: Path, spec: Path):
    _policy(
        project, {"schedule": {"timezone": "UTC", "allowed_hours": ["00:00-24:00"]}}
    )
    guards = SessionGuards(spec, "validation")
    assert not guards.tripped
    _closed(project)
    load_policy(project)  # the cache follows the file
    guards.call("Read", {"file_path": "a.py"}, "c1")
    assert guards.tripped
    assert read_pause_state(spec)["paused_phase"] == "qa_review"


def test_the_token_budget_pauses_the_task(project: Path, spec: Path):
    _policy(project, {"budget": {"max_tokens_per_hour": 1000}})
    _usage(project, (400, datetime.now(UTC)))
    assert not PolicyWatch(spec, "planning").tripped
    _usage(project, (400, datetime.now(UTC)), (700, datetime.now(UTC)))
    watch = PolicyWatch(spec, "planning")
    assert watch.tripped
    state = read_pause_state(spec)
    assert state["reason"] == BUDGET_REASON
    assert state["policy"] == {
        "reason": BUDGET_REASON,
        "tokensLastHour": 1100,
        "maxTokensPerHour": 1000,
    }
    [event] = read_events(project)
    assert event["decision"] == "budget_exceeded"
    assert "1,100 tokens in the last hour" in event["reason"]


def test_before_a_session_the_coder_does_not_start(project: Path, spec: Path):
    _closed(project)
    status = SimpleNamespace(updates=[])
    status.update = lambda **kw: status.updates.append(kw)
    with pytest.raises(BuildPaused):
        iteration_guards._check_policy(spec, "coding", status)
    assert status.updates and read_pause_state(spec)["reason"] == HOURS_REASON


def test_inside_the_hours_the_coder_goes_on(project: Path, spec: Path):
    status = SimpleNamespace(update=lambda **kw: None)
    iteration_guards._check_policy(spec, "coding", status)
    assert policy_pause_before_session(spec, "coding") is None


def test_before_a_session_the_reason_is_returned(project: Path, spec: Path):
    _closed(project)
    assert policy_pause_before_session(spec, "qa_review") == HOURS_REASON
    assert read_pause_state(spec)["paused_phase"] == "qa_review"


@pytest.mark.parametrize(
    ("client", "expected"),
    [
        (None, (None, None)),
        (FakeAgentClient(), ("openai", "gpt-5")),
        (
            SimpleNamespace(options=SimpleNamespace(model="claude-x")),
            ("claude", "claude-x"),
        ),
        (SimpleNamespace(options=None), (None, None)),
        (SimpleNamespace(provider_name=lambda: "local", model=""), ("local", None)),
    ],
)
def test_the_provider_and_model_come_from_the_client(client, expected):
    assert _identity(client) == expected


def test_a_client_that_cannot_name_itself_is_unnamed():
    def broken() -> str:
        raise TypeError("no")

    assert _identity(SimpleNamespace(provider_name=broken, model="m")) == (None, "m")
