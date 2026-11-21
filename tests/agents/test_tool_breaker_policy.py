"""The circuit breaker's limit from workpilot.policy.yaml, and its trips in the audit trail (#353, lot 3).

What these tests keep away: a machine setting that turns a team's loop limit
off or loosens it; a breaker trip that leaves no line in the audit trail the
team exports.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from agents.tool_breaker import (
    DEFAULT_LIMIT,
    LIMIT_ENV,
    ToolBreaker,
    effective_limit,
    policy_limit,
)
from security.policy_audit import read_events


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )
    monkeypatch.delenv(LIMIT_ENV, raising=False)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return root


@pytest.fixture
def spec(project: Path) -> Path:
    return project / ".workpilot" / "specs" / "001-x"


def _loop_limit(project: Path, limit: int) -> None:
    (project / "workpilot.policy.yaml").write_text(
        yaml.safe_dump({"loop_detection": {"max_same_tool_call": limit}}),
        encoding="utf-8",
    )


def _repeat(breaker: ToolBreaker, times: int) -> list[bool]:
    trips = []
    for index in range(times):
        breaker.call("Read", {"file_path": "a.py"}, f"c{index}")
        trips.append(breaker.result("same", False, f"c{index}"))
    return trips


def test_without_a_policy_the_machine_setting_applies(spec: Path, monkeypatch):
    assert policy_limit(spec) is None
    assert effective_limit(spec) == (DEFAULT_LIMIT, False)
    monkeypatch.setenv(LIMIT_ENV, "0")
    assert effective_limit(spec) == (0, False)


def test_a_spec_outside_a_project_has_no_policy(tmp_path: Path):
    assert policy_limit(tmp_path / "loose") is None


def test_the_policy_sets_the_limit(project: Path, spec: Path):
    _loop_limit(project, 3)
    breaker = ToolBreaker(spec, "coding")
    assert (breaker.limit, breaker.from_policy) == (3, True)
    assert _repeat(breaker, 3) == [False, False, True]
    [event] = read_events(project)
    assert event["decision"] == "tool_loop"
    assert event["tool"] == "Read" and event["task"] == "001-x"
    assert event["rules"] == ["loop_detection.max_same_tool_call"]
    assert "3 times" in event["reason"]


@pytest.mark.parametrize(("raw", "expected"), [("0", 8), ("20", 8), ("", 8), ("x", 8)])
def test_the_machine_cannot_loosen_the_team_limit(
    project: Path, spec: Path, monkeypatch, raw: str, expected: int
):
    _loop_limit(project, 8)
    monkeypatch.setenv(LIMIT_ENV, raw)
    assert effective_limit(spec) == (expected, True)


def test_the_machine_may_be_stricter(project: Path, spec: Path, monkeypatch):
    _loop_limit(project, 8)
    monkeypatch.setenv(LIMIT_ENV, "2")
    breaker = ToolBreaker(spec, "coding")
    assert (breaker.limit, breaker.from_policy) == (2, False)
    assert _repeat(breaker, 2) == [False, True]
    assert read_events(project)[0]["rules"] == []


def test_a_trip_outside_a_project_writes_no_trail(tmp_path: Path):
    loose = tmp_path / "loose"
    breaker = ToolBreaker(loose, "coding", limit=2)
    assert _repeat(breaker, 2) == [False, True]
    assert not (tmp_path / ".workpilot").exists()
