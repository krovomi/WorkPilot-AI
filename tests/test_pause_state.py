"""The cooperative pause: one store, read the same way by every phase.

The pause flag used to live inside `implementation_plan.json`. That file does
not exist during spec creation or planning, so a user who pressed Pause on a
task that was visibly running got "Implementation plan not found" — the feature
existed only for the one phase that happened to have written a plan already.

These tests pin the two properties that fix costs: the store exists whenever the
spec directory does, and a task paused by the previous version stays paused
after the upgrade.
"""

import json

import pytest

from core.build_signals import BuildHalted, BuildPaused
from core.pause_state import (
    PAUSE_STATE_FILE,
    clear_pause_state,
    is_paused,
    read_pause_state,
    write_pause_state,
)


@pytest.fixture
def spec_dir(tmp_path):
    d = tmp_path / "001-feature"
    d.mkdir()
    return d


def test_a_spec_with_no_plan_can_be_paused(spec_dir):
    """The case the previous store could not represent at all."""
    assert not (spec_dir / "implementation_plan.json").exists()

    write_pause_state(spec_dir, phase="planning")

    assert is_paused(spec_dir)
    assert read_pause_state(spec_dir)["paused_phase"] == "planning"


def test_not_paused_when_nothing_was_written(spec_dir):
    assert not is_paused(spec_dir)
    assert read_pause_state(spec_dir) == {}


def test_clear_lifts_the_pause_but_keeps_the_phase(spec_dir):
    write_pause_state(spec_dir, phase="qa_review", subtask_id="subtask-2-1")

    clear_pause_state(spec_dir)

    state = read_pause_state(spec_dir)
    assert not is_paused(spec_dir)
    assert state["paused_phase"] == "qa_review"
    assert state["paused_subtask_id"] is None


def test_legacy_in_plan_flag_is_still_honoured(spec_dir):
    """A task paused before this change must not silently un-pause on upgrade."""
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [],
                "paused": {
                    "enabled": True,
                    "paused_at": "2026-01-01T00:00:00+00:00",
                    "paused_subtask_id": "subtask-1-1",
                },
            }
        ),
        encoding="utf-8",
    )

    assert is_paused(spec_dir)
    assert read_pause_state(spec_dir)["paused_subtask_id"] == "subtask-1-1"


def test_the_new_store_wins_over_the_legacy_one(spec_dir):
    """Resuming writes the new store; the stale plan flag must not resurrect it."""
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"paused": {"enabled": True, "paused_at": None}}),
        encoding="utf-8",
    )
    write_pause_state(spec_dir, phase="coding")
    clear_pause_state(spec_dir)

    assert not is_paused(spec_dir)


def test_an_unknown_phase_is_not_written_verbatim(spec_dir):
    """The phase reaches a file a person reads; it is a closed set, not free text."""
    write_pause_state(spec_dir, phase="whatever-the-caller-passed")

    assert read_pause_state(spec_dir)["paused_phase"] == "coding"


def test_pause_state_file_name_is_the_one_the_frontend_writes(spec_dir):
    """Both sides address the same path; a rename here is a silent divergence."""
    write_pause_state(spec_dir, phase="coding")

    assert (spec_dir / PAUSE_STATE_FILE).exists()
    assert PAUSE_STATE_FILE == "pause_state.json"


def test_build_paused_carries_where_it_stopped():
    paused = BuildPaused("qa_review", "subtask-3-2")

    assert paused.phase == "qa_review"
    assert paused.subtask_id == "subtask-3-2"
    assert "qa_review" in str(paused)


def test_build_halted_carries_the_message_the_user_will_read():
    halted = BuildHalted("planning", "The model produced no valid plan.")

    assert halted.phase == "planning"
    assert str(halted) == "The model produced no valid plan."
    assert halted.recoverable is True
