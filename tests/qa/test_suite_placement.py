"""`qa.suite_placement`: the reviewer's door to `test_placement`."""

from __future__ import annotations

import json

import pytest
from foundation.build_signals import BuildPaused
from foundation.change_scope import ChangeScope
from foundation.pause_state import write_pause_state
from qa import suite_placement
from test_placement.decide import Decision


def _spec(tmp_path, metadata=None):
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    if metadata is not None:
        (spec / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return project, spec


def test_the_pr_comes_from_the_card():
    assert suite_placement._has_pr({"prUrl": "https://example.test/pr/1"})
    assert not suite_placement._has_pr({"prUrl": "  "})
    assert not suite_placement._has_pr({})


def test_the_cards_choice_is_the_tasks_choice(monkeypatch):
    monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT", "machine")
    env = suite_placement._environment({"testPlacement": " CI "})
    assert env is not None and env["WORKPILOT_TEST_PLACEMENT"] == "ci"
    assert suite_placement._environment({"testPlacement": "cloud"}) is None
    assert suite_placement._environment({}) is None


async def test_a_card_set_to_this_machine_stays_here(tmp_path, monkeypatch):
    project, spec = _spec(
        tmp_path, {"prUrl": "https://example.test/pr/1", "testPlacement": "machine"}
    )
    monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT", "ci")
    monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT_ROUTES", "ci")
    placement = await suite_placement.place_full_suite(project, spec, None)
    assert placement is not None and placement.runs_here
    assert placement.decision.reason == "chosen"


def test_a_pause_stops_the_wait_with_the_builds_signal(tmp_path):
    _project, spec = _spec(tmp_path)
    check = suite_placement._pause_check(spec)
    check()
    write_pause_state(spec, phase="qa_review")
    with pytest.raises(BuildPaused):
        check()


def test_the_wait_is_announced(capsys):
    suite_placement._announce_wait(Decision("queue", "no_route", "auto", ("cpu",)))
    suite_placement._announce_wait(Decision("queue", "no_route", "auto"))
    out = capsys.readouterr().out
    assert "short of cpu" in out and "short of room" in out


async def test_a_scoped_review_is_not_placed(tmp_path):
    project, spec = _spec(tmp_path)
    scope = ChangeScope(level="light", reason="test")
    assert await suite_placement.place_full_suite(project, spec, scope) is None


async def test_a_suite_moved_elsewhere_is_said(tmp_path, monkeypatch, capsys):
    project, spec = _spec(tmp_path, {"prUrl": "https://example.test/pr/1"})
    monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT", "ci")
    monkeypatch.setenv("WORKPILOT_TEST_PLACEMENT_ROUTES", "ci")
    placement = await suite_placement.place_full_suite(project, spec, None)
    assert placement is not None and placement.decision.target == "ci"
    assert "run on: ci" in capsys.readouterr().out


async def test_a_machine_that_cannot_be_read_never_holds_qa_back(
    tmp_path, monkeypatch, caplog
):
    project, spec = _spec(tmp_path)

    async def broken(*_args, **_kwargs):
        raise OSError("no /proc")

    monkeypatch.setattr(suite_placement, "prepare", broken)
    assert await suite_placement.place_full_suite(project, spec, None) is None
    assert "runs here" in caplog.text
