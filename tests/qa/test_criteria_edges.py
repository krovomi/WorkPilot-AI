"""The plan readers and budget knobs on the paths the loop tests never take."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from qa import budget
from qa.criteria import (
    get_architecture_status,
    is_architecture_approved,
    print_qa_status,
    save_implementation_plan,
    snapshot_plan_for_model,
)


@pytest.mark.parametrize(
    ("raw", "value"), [(None, 8), ("", 8), ("abc", 8), ("1", 8), ("5", 5)]
)
def test_an_integer_knob_falls_back_on_a_bad_value(monkeypatch, raw, value):
    if raw is None:
        monkeypatch.delenv("WORKPILOT_TEST_KNOB", raising=False)
    else:
        monkeypatch.setenv("WORKPILOT_TEST_KNOB", raw)

    assert budget._read_int_env("WORKPILOT_TEST_KNOB", 8, minimum=2) == value


def test_a_plan_that_cannot_be_saved_says_so(tmp_path: Path):
    assert save_implementation_plan(tmp_path / "missing", {"a": 1}) is False


def test_a_snapshot_that_cannot_be_written_is_none(qa_spec: Path, tmp_path: Path):
    blocker = tmp_path / "file"
    blocker.write_text("", encoding="utf-8")

    assert (
        snapshot_plan_for_model(qa_spec, "p", "m", valid=True, dest_dir=blocker) is None
    )


def _plan(spec: Path, **fields) -> None:
    (spec / "implementation_plan.json").write_text(json.dumps(fields), encoding="utf-8")


def test_the_architecture_verdict_is_read_from_the_plan(qa_spec: Path, tmp_path: Path):
    assert get_architecture_status(tmp_path) is None
    assert is_architecture_approved(qa_spec) is True  # no rules: nothing to break

    _plan(qa_spec, architecture_enforcement={"status": "rejected"})
    assert get_architecture_status(qa_spec) == {"status": "rejected"}
    assert is_architecture_approved(qa_spec) is False

    _plan(qa_spec, architecture_enforcement={"status": "approved"})
    assert is_architecture_approved(qa_spec) is True


def test_a_status_that_is_neither_verdict_prints_no_detail(qa_spec: Path, capsys):
    _plan(qa_spec, qa_signoff={"status": "fixes_applied", "qa_session": 2})

    print_qa_status(qa_spec)

    out = capsys.readouterr().out
    assert "QA Status: FIXES_APPLIED" in out
    assert "Tests:" not in out and "Issues Found" not in out
