"""Tests for the hot LLM swap foundation (agents/hot_swap.py)."""

import json

from agents.hot_swap import (
    HotSwapRequest,
    apply_hot_swap_to_metadata,
    config_phase_for_log_phase,
    consume_hot_swap_for_phase,
    consume_hot_swap_marker,
    hot_swap_differs,
    read_hot_swap_marker,
    should_break_for_hot_swap,
    write_hot_swap_marker,
)


def test_config_phase_for_log_phase():
    assert config_phase_for_log_phase("planning") == "planning"
    assert config_phase_for_log_phase("coding") == "coding"
    assert config_phase_for_log_phase("validation") == "qa"


def test_should_break_for_hot_swap():
    # No marker → no break.
    assert should_break_for_hot_swap(None, "planning", "anthropic", "m") is False
    # Marker for a DIFFERENT phase → no break (would otherwise loop forever).
    coding_marker = HotSwapRequest(phase="coding", model="claude-opus-4-8")
    assert (
        should_break_for_hot_swap(coding_marker, "planning", "anthropic", "claude-sonnet-4-5")
        is False
    )
    # Marker for THIS phase that changes the model → break.
    planning_marker = HotSwapRequest(phase="planning", model="claude-opus-4-8")
    assert (
        should_break_for_hot_swap(planning_marker, "planning", "anthropic", "claude-sonnet-4-5")
        is True
    )
    # validation log phase maps to qa config → a qa marker breaks it.
    qa_marker = HotSwapRequest(phase="qa", provider="copilot")
    assert should_break_for_hot_swap(qa_marker, "validation", "anthropic", "m") is True
    # Same model already active → no break.
    same = HotSwapRequest(phase="planning", model="claude-opus-4-8")
    assert should_break_for_hot_swap(same, "planning", "anthropic", "claude-opus-4-8") is False


def test_consume_for_phase_only_matching(tmp_path):
    write_hot_swap_marker(tmp_path, "qa", model="claude-opus-4-8")
    # A different phase must NOT consume it (leaves it in place).
    assert consume_hot_swap_for_phase(tmp_path, "coding") is None
    assert (tmp_path / "HOT_SWAP.json").exists()
    # The matching phase consumes + deletes it.
    req = consume_hot_swap_for_phase(tmp_path, "qa")
    assert req is not None and req.phase == "qa"
    assert not (tmp_path / "HOT_SWAP.json").exists()


def test_write_read_consume_roundtrip(tmp_path):
    assert write_hot_swap_marker(
        tmp_path, "coding", provider="anthropic", model="claude-sonnet-4-5", effort="high"
    )
    req = read_hot_swap_marker(tmp_path)
    assert req == HotSwapRequest(
        phase="coding",
        provider="anthropic",
        model="claude-sonnet-4-5",
        effort="high",
    )
    # read does not delete
    assert (tmp_path / "HOT_SWAP.json").exists()
    # consume deletes (single-shot)
    consumed = consume_hot_swap_marker(tmp_path)
    assert consumed == req
    assert not (tmp_path / "HOT_SWAP.json").exists()
    assert consume_hot_swap_marker(tmp_path) is None


def test_absent_marker_is_none(tmp_path):
    assert read_hot_swap_marker(tmp_path) is None
    assert consume_hot_swap_marker(tmp_path) is None


def test_invalid_phase_or_empty_rejected(tmp_path):
    assert not write_hot_swap_marker(tmp_path, "bogus", model="x")
    # empty request (all fields None) → not readable
    write_hot_swap_marker(tmp_path, "coding")
    assert read_hot_swap_marker(tmp_path) is None
    # invalid effort is dropped, not fatal
    write_hot_swap_marker(tmp_path, "coding", model="m", effort="turbo")
    req = read_hot_swap_marker(tmp_path)
    assert req is not None and req.effort is None and req.model == "m"


def test_malformed_json_is_none(tmp_path):
    (tmp_path / "HOT_SWAP.json").write_text("{not json", encoding="utf-8")
    assert read_hot_swap_marker(tmp_path) is None


def test_hot_swap_differs():
    req = HotSwapRequest(phase="coding", model="claude-opus-4-8")
    assert hot_swap_differs(req, "anthropic", "claude-sonnet-4-5") is True
    # loose model match: alias "opus-4-8" is a substring of full id
    # "claude-opus-4-8" → treated as the SAME model → no diff.
    assert (
        hot_swap_differs(
            HotSwapRequest(phase="coding", model="opus-4-8"),
            "anthropic",
            "claude-opus-4-8",
        )
        is False
    )

    # identical full ids: no diff
    assert (
        hot_swap_differs(
            HotSwapRequest(phase="coding", model="claude-opus-4-8"),
            "anthropic",
            "claude-opus-4-8",
        )
        is False
    )
    # provider change alone
    assert (
        hot_swap_differs(HotSwapRequest(phase="coding", provider="copilot"), "anthropic", "m")
        is True
    )
    # effort change alone
    assert (
        hot_swap_differs(
            HotSwapRequest(phase="coding", effort="low"), "anthropic", "m", "high"
        )
        is True
    )
    # None request → never differs
    assert hot_swap_differs(None, "anthropic", "m") is False


def test_apply_to_metadata_sets_per_phase_keys(tmp_path):
    (tmp_path / "task_metadata.json").write_text(
        json.dumps(
            {
                "provider": "anthropic",
                "phaseModels": {"coding": "claude-opus-4-5"},
                "phaseProviders": {"coding": "anthropic"},
            }
        ),
        encoding="utf-8",
    )
    apply_hot_swap_to_metadata(
        tmp_path,
        HotSwapRequest(
            phase="coding", provider="copilot", model="claude-sonnet-4.6", effort="low"
        ),
    )
    meta = json.loads((tmp_path / "task_metadata.json").read_text(encoding="utf-8"))
    assert meta["phaseModels"]["coding"] == "claude-sonnet-4.6"
    assert meta["phaseProviders"]["coding"] == "copilot"
    assert meta["phaseThinking"]["coding"] == "low"
    assert meta["isAutoProfile"] is True


def test_apply_to_metadata_missing_file_is_noop(tmp_path):
    # Should not raise when metadata doesn't exist.
    apply_hot_swap_to_metadata(tmp_path, HotSwapRequest(phase="coding", model="m"))
