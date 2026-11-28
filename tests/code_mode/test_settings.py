"""Whether a session is offered ``run_script``: off unless the switch says so."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from code_mode.settings import ENV_VAR, effective_mode, offered, switch


def _spec(tmp_path: Path, **metadata) -> Path:
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "task_metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    return spec


def test_the_switch_is_off_when_absent_or_malformed():
    assert switch({}) == "off"
    assert switch({ENV_VAR: "always"}) == "off"
    assert switch({ENV_VAR: " AUTO "}) == "auto"
    assert switch({ENV_VAR: "on"}) == "on"


def test_off_offers_nothing_whatever_the_task_says(tmp_path: Path):
    spec = _spec(tmp_path, codeMode="on", phaseCodeMode={"coding": "on"})
    assert effective_mode("coder", spec, {}) == "off"
    assert not offered("coder", spec, {})
    assert not offered(None, None, {})


@pytest.mark.parametrize(
    ("agent_type", "expected"),
    [
        ("coder", True),
        ("qa_reviewer", True),
        ("qa_fixer", True),
        ("verifier", True),
        ("spec_researcher", True),
        ("analyzer", True),
        ("spec_writer", False),
        ("pr_reviewer", False),
        ("ideation", False),
        ("planner", False),
        (None, False),
    ],
)
def test_auto_offers_it_where_it_pays(agent_type, expected):
    assert offered(agent_type, None, {ENV_VAR: "auto"}) is expected


def test_on_offers_it_to_every_type(tmp_path: Path):
    assert offered("pr_reviewer", None, {ENV_VAR: "on"})
    assert offered(None, None, {ENV_VAR: "on"})


def test_auto_leaves_a_small_task_alone(tmp_path: Path):
    spec = _spec(tmp_path, complexity="simple")
    assert not offered("coder", spec, {ENV_VAR: "auto"})
    assert offered("qa_reviewer", spec, {ENV_VAR: "auto"})
    # Chosen for the task, it is on even for a small one.
    spec2 = tmp_path / "two"
    spec2.mkdir()
    (spec2 / "task_metadata.json").write_text(
        json.dumps({"complexity": "simple", "codeMode": "on"}), encoding="utf-8"
    )
    assert offered("coder", spec2, {ENV_VAR: "auto"})


def test_the_phase_wins_over_the_task_and_the_task_over_the_switch(tmp_path: Path):
    spec = _spec(tmp_path, codeMode="off", phaseCodeMode={"qa": "on", "coding": "bad"})
    env = {ENV_VAR: "on"}
    assert effective_mode("coder", spec, env) == "off"
    assert effective_mode("qa_fixer", spec, env) == "on"
    assert effective_mode("planner", spec, env) == "off"
    assert effective_mode("pr_reviewer", spec, env) == "off"


def test_unreadable_metadata_is_the_switch(tmp_path: Path):
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "task_metadata.json").write_text("{nope", encoding="utf-8")
    assert effective_mode("coder", spec, {ENV_VAR: "auto"}) == "auto"
    (spec / "task_metadata.json").write_text("[1]", encoding="utf-8")
    assert effective_mode("coder", spec, {ENV_VAR: "auto"}) == "auto"
    assert effective_mode("coder", tmp_path / "missing", {ENV_VAR: "on"}) == "on"
