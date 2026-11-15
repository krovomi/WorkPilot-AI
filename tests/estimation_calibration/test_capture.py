"""At merge: the spec's estimate against what it actually used."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from core.merge_event import MergeEvent
from estimation_calibration import load
from estimation_calibration.capture import (
    capture,
    on_merge,
    read_estimate,
    read_files_changed,
    read_qa_iterations,
    read_usage,
)

SPEC = "007-add-export"


def _write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _estimate(root: Path, smart: object) -> None:
    _write(
        root / ".workpilot" / "specs" / SPEC / "task_metadata.json",
        {"smartEstimate": smart},
    )


def _git(root: Path, *args: str) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Ana",
        GIT_AUTHOR_EMAIL="ana@example.test",
        GIT_COMMITTER_NAME="Ana",
        GIT_COMMITTER_EMAIL="ana@example.test",
    )
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, env=env)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.txt").write_text("a\n", encoding="utf-8")
    _git(tmp_path, "add", "a.txt")
    _git(tmp_path, "commit", "-q", "-m", "init")
    return tmp_path


INPUTS = {
    "cost_usd": {"base": 2.0, "value": 3.0},
    "tokens": {"base": 50_000},
    "qa_iterations": {"base": 2, "value": "x"},
    "files": "nope",
}


def test_read_estimate_validates_what_the_task_kept(tmp_path):
    _estimate(
        tmp_path,
        {"category": "backend", "calibrationInputs": INPUTS, "adjustedScore": 8},
    )
    assert read_estimate(tmp_path, SPEC) == {
        "category": "backend",
        "estimated": {"cost_usd": 2.0, "tokens": 50_000.0, "qa_iterations": 2.0},
        "shown": {"cost_usd": 3.0, "tokens": 50_000.0, "qa_iterations": 2.0},
        "adjusted": True,
    }


def test_an_unknown_category_is_read_as_feature(tmp_path):
    _estimate(tmp_path, {"category": "<script>", "calibrationInputs": INPUTS})
    estimate = read_estimate(tmp_path, SPEC)
    assert estimate["category"] == "feature"
    assert estimate["adjusted"] is False


@pytest.mark.parametrize(
    "smart",
    [None, "text", {"calibrationInputs": "x"}, {"calibrationInputs": {"files": {"base": 0}}}],
)
def test_no_usable_estimate_means_no_sample(tmp_path, smart):
    _estimate(tmp_path, smart)
    assert read_estimate(tmp_path, SPEC) is None


def test_read_usage_sums_the_spec_and_names_its_main_provider(tmp_path):
    _write(
        tmp_path / ".workpilot" / "cost_data.json",
        {
            "usages": [
                {"spec_id": SPEC, "provider": "openai", "cost": 0.5,
                 "input_tokens": 100, "output_tokens": 50},
                {"spec_id": SPEC, "provider": "anthropic", "cost": 1.0,
                 "input_tokens": 1000, "output_tokens": 500},
                {"spec_id": SPEC, "provider": "", "cost": -3, "input_tokens": "x"},
                {"spec_id": "other", "provider": "openai", "cost": 9.0},
                "garbage",
            ]
        },
    )
    assert read_usage(tmp_path, SPEC) == {
        "cost_usd": 1.5, "tokens": 1650.0, "provider": "anthropic",
    }


def test_read_usage_without_a_ledger(tmp_path):
    assert read_usage(tmp_path, SPEC) == {"cost_usd": 0.0, "tokens": 0.0, "provider": None}
    _write(tmp_path / ".workpilot" / "cost_data.json", {"usages": "x"})
    assert read_usage(tmp_path, SPEC)["provider"] is None


def test_read_qa_iterations_takes_the_highest_of_both_plans(tmp_path):
    assert read_qa_iterations(tmp_path, SPEC) == 0
    _write(
        tmp_path / ".workpilot" / "specs" / SPEC / "implementation_plan.json",
        {"qa_signoff": {"qa_session": 2}, "qa_stats": "x"},
    )
    _write(
        tmp_path / ".workpilot" / "worktrees" / "tasks" / SPEC / ".workpilot"
        / "specs" / SPEC / "implementation_plan.json",
        {"qa_signoff": "x", "qa_stats": {"total_iterations": 3}},
    )
    assert read_qa_iterations(tmp_path, SPEC) == 3


def test_read_files_changed_counts_the_staged_merge(repo):
    (repo / "b.txt").write_text("b\n", encoding="utf-8")
    (repo / "a.txt").write_text("a2\n", encoding="utf-8")
    _git(repo, "add", "a.txt", "b.txt")
    assert read_files_changed(repo, SPEC) == 2


def test_read_files_changed_reads_the_branch_once_committed(repo):
    _git(repo, "checkout", "-q", "-b", f"workpilot/{SPEC}")
    (repo / "c.txt").write_text("c\n", encoding="utf-8")
    _git(repo, "add", "c.txt")
    _git(repo, "commit", "-q", "-m", "feature")
    _git(repo, "checkout", "-q", "main")
    _git(repo, "merge", "-q", "--no-ff", "-m", "merge", f"workpilot/{SPEC}")
    assert read_files_changed(repo, SPEC) == 1


def test_read_files_changed_outside_a_repository(tmp_path):
    assert read_files_changed(tmp_path, SPEC) == 0


def test_capture_refuses_a_spec_name_that_is_a_path(tmp_path):
    assert capture(tmp_path, "../outside") is None
    assert capture(tmp_path, "-x") is None


def test_capture_without_an_estimate(tmp_path):
    assert capture(tmp_path, SPEC) is None


def test_a_merge_records_the_sample(repo):
    _estimate(repo, {"category": "infra", "calibrationInputs": INPUTS})
    _write(
        repo / ".workpilot" / "cost_data.json",
        {"usages": [{"spec_id": SPEC, "provider": "ollama", "cost": 0,
                     "input_tokens": 10, "output_tokens": 5}]},
    )
    on_merge(MergeEvent(repo, SPEC))
    [sample] = load(repo)["samples"]
    assert sample["spec"] == SPEC
    assert sample["category"] == "infra"
    assert sample["provider"] == "ollama"
    # .workpilot/ files are not staged; nothing else changed.
    assert sample["actual"] == {"cost_usd": 0.0, "tokens": 15.0, "qa_iterations": 0,
                                "files": 0}
    assert "duration" not in json.dumps(sample)


def test_a_merge_of_a_spec_never_estimated_records_nothing(repo):
    on_merge(MergeEvent(repo, SPEC))
    assert load(repo)["samples"] == []
