"""The hot-swap marker: a provider or model change asked for while a phase runs.

The app writes the marker, the running phase reads it, applies it to
``task_metadata.json`` and removes it. Every step is best-effort: a marker or
metadata file that cannot be read or written leaves the build as it was.
"""

from __future__ import annotations

import json
from pathlib import Path

from agents import hot_swap
from agents.hot_swap import HotSwapRequest


def _marker(spec: Path) -> Path:
    return hot_swap._marker_path(spec)


def test_a_marker_is_written_read_once_and_gone(tmp_path: Path) -> None:
    assert hot_swap.write_hot_swap_marker(
        tmp_path, "coding", provider="openai", model="gpt-test", effort="turbo"
    )

    req = hot_swap.consume_hot_swap_marker(tmp_path)

    # An effort outside the list is dropped, the rest is kept.
    assert req == HotSwapRequest("coding", "openai", "gpt-test", None)
    assert not _marker(tmp_path).exists()
    assert hot_swap.consume_hot_swap_marker(tmp_path) is None


def test_a_marker_for_another_phase_waits_for_it(tmp_path: Path) -> None:
    hot_swap.write_hot_swap_marker(tmp_path, "qa", model="opus")

    assert hot_swap.consume_hot_swap_for_phase(tmp_path, "coding") is None
    assert _marker(tmp_path).exists()
    assert hot_swap.consume_hot_swap_for_phase(tmp_path, "qa") is not None


def test_a_marker_that_cannot_be_written_is_refused(tmp_path: Path) -> None:
    assert hot_swap.write_hot_swap_marker(tmp_path, "deploy", model="m") is False
    # The spec directory does not exist: the write fails, quietly.
    assert (
        hot_swap.write_hot_swap_marker(tmp_path / "gone", "coding", model="m") is False
    )


def test_a_marker_that_says_nothing_usable_is_none(tmp_path: Path) -> None:
    for content in (
        "{not json",
        json.dumps(["coding"]),
        json.dumps({"phase": "deploy", "model": "m"}),
        json.dumps({"phase": "coding"}),
    ):
        _marker(tmp_path).write_text(content, encoding="utf-8")
        assert hot_swap.read_hot_swap_marker(tmp_path) is None


def test_clearing_a_marker_that_is_not_a_file_is_harmless(tmp_path: Path) -> None:
    _marker(tmp_path).mkdir()

    hot_swap.clear_hot_swap_marker(tmp_path)

    assert _marker(tmp_path).is_dir()


def test_a_model_on_a_session_with_none_is_a_change() -> None:
    assert hot_swap.hot_swap_differs(HotSwapRequest("coding", model="opus"), None, None)


def test_the_request_lands_in_the_phase_settings(tmp_path: Path) -> None:
    meta = tmp_path / "task_metadata.json"
    meta.write_text(
        json.dumps({"phaseModels": "bad", "phaseProviders": [], "phaseThinking": 3}),
        encoding="utf-8",
    )

    hot_swap.apply_hot_swap_to_metadata(
        tmp_path, HotSwapRequest("planning", "openai", "gpt-test", "high")
    )

    data = json.loads(meta.read_text(encoding="utf-8"))
    assert data["phaseModels"] == {"planning": "gpt-test"}
    assert data["phaseProviders"] == {"planning": "openai"}
    assert data["phaseThinking"] == {"planning": "high"}
    assert data["isAutoProfile"] is True


def test_metadata_it_cannot_read_or_write_is_left_alone(tmp_path: Path) -> None:
    meta = tmp_path / "task_metadata.json"
    req = HotSwapRequest("coding", model="opus")

    for content in ("{broken", json.dumps(["not", "an", "object"])):
        meta.write_text(content, encoding="utf-8")
        hot_swap.apply_hot_swap_to_metadata(tmp_path, req)
        assert meta.read_text(encoding="utf-8") == content

    # A spec directory that is gone: nothing is written, nothing raises.
    hot_swap.apply_hot_swap_to_metadata(tmp_path / "gone", req)
    assert not (tmp_path / "gone").exists()


def test_the_activity_feed_names_what_changes() -> None:
    assert hot_swap.describe_hot_swap(
        HotSwapRequest("qa", "openai", "gpt-test", "low")
    ) == ("🔄 Hot swap (qa) — Provider → openai · Model → gpt-test · Effort → low")
    assert hot_swap.describe_hot_swap(HotSwapRequest("qa", model="opus")) == (
        "🔄 Hot swap (qa) — Model → opus"
    )
