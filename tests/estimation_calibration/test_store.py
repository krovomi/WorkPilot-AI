"""The calibration file of a repository."""

from __future__ import annotations

import json

from estimation_calibration import load, record_adjustment, record_sample, reset
from estimation_calibration.store import MAX_ENTRIES, RELATIVE


def test_missing_or_broken_file_reads_as_empty(tmp_path):
    assert load(tmp_path)["samples"] == []
    target = tmp_path / RELATIVE
    target.parent.mkdir(parents=True)
    target.write_text("{not json", encoding="utf-8")
    assert load(tmp_path) == {
        "version": 1, "samples": [], "adjustments": [], "reset_at": None,
    }
    target.write_text("[1, 2]", encoding="utf-8")
    assert load(tmp_path)["adjustments"] == []


def test_entries_that_are_not_objects_are_dropped(tmp_path):
    target = tmp_path / RELATIVE
    target.parent.mkdir(parents=True)
    target.write_text(
        json.dumps({"samples": [{"spec": "a"}, "x", 3], "adjustments": "no",
                    "reset_at": 5}),
        encoding="utf-8",
    )
    data = load(tmp_path)
    assert data["samples"] == [{"spec": "a"}]
    assert data["adjustments"] == []
    assert data["reset_at"] is None


def test_a_spec_merged_twice_keeps_its_latest_sample(tmp_path):
    record_sample(tmp_path, {"spec": "001", "actual": {"files": 1}})
    record_sample(tmp_path, {"spec": "002", "actual": {"files": 2}})
    record_sample(tmp_path, {"spec": "001", "actual": {"files": 3}})
    samples = load(tmp_path)["samples"]
    assert [s["spec"] for s in samples] == ["002", "001"]
    assert samples[-1]["actual"] == {"files": 3}
    assert "at" in samples[-1]


def test_entries_are_capped(tmp_path):
    for i in range(MAX_ENTRIES + 2):
        record_adjustment(tmp_path, "infra", 3, 4 + i % 2)
    assert len(load(tmp_path)["adjustments"]) == MAX_ENTRIES


def test_reset_forgets_everything(tmp_path):
    record_sample(tmp_path, {"spec": "001"})
    record_adjustment(tmp_path, "backend", 3, 5)
    written = reset(tmp_path)
    data = load(tmp_path)
    assert data["samples"] == [] and data["adjustments"] == []
    assert isinstance(data["reset_at"], str)
    assert written["reset_at"] == data["reset_at"]


def test_a_linked_folder_is_neither_read_nor_written(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "estimation").mkdir(parents=True)
    (elsewhere / "estimation" / "calibration.json").write_text(
        json.dumps({"samples": [{"spec": "planted"}]}), encoding="utf-8"
    )
    project = tmp_path / "project"
    project.mkdir()
    (project / ".workpilot").symlink_to(elsewhere, target_is_directory=True)
    assert load(project)["samples"] == []
    assert record_sample(project, {"spec": "x"}) is None
    assert reset(project) is None
    assert "x" not in (elsewhere / "estimation" / "calibration.json").read_text(
        encoding="utf-8"
    )


def test_a_linked_file_is_neither_read_nor_written(tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"samples": [{"spec": "planted"}]}), encoding="utf-8")
    project = tmp_path / "project"
    (project / RELATIVE).parent.mkdir(parents=True)
    (project / RELATIVE).symlink_to(outside)
    assert load(project)["samples"] == []
    assert record_adjustment(project, "infra", 2, 3) is None
