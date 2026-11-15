"""The calibration runner, run as the Electron main runs it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from estimation_calibration import load
from estimation_calibration.store import RELATIVE
from runners.estimation_calibration_runner import ERROR_PREFIX, RESULT_PREFIX, run

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "estimation_calibration_runner.py"
)


def _result(out: str) -> dict:
    line = next(x for x in out.splitlines() if x.startswith(RESULT_PREFIX))
    return json.loads(line[len(RESULT_PREFIX) :])


def test_adjust_then_reset(tmp_path, capsys):
    args = [
        "--project-path",
        str(tmp_path),
        "--action",
        "adjust",
        "--category",
        "backend",
        "--base-score",
        "5",
        "--adjusted-score",
        "8",
    ]
    assert run(args) == 0
    assert _result(capsys.readouterr().out) == {
        "samples": 0,
        "adjustments": 1,
        "reset_at": None,
    }
    assert load(tmp_path)["adjustments"][0]["adjusted_score"] == 8

    assert run(["--project-path", str(tmp_path), "--action", "reset"]) == 0
    summary = _result(capsys.readouterr().out)
    assert summary["adjustments"] == 0 and summary["reset_at"]


def test_a_missing_project_is_refused(tmp_path, capsys):
    assert run(["--project-path", str(tmp_path / "no"), "--action", "reset"]) == 1
    assert capsys.readouterr().out.startswith(ERROR_PREFIX)


def test_adjust_needs_valid_scores_and_a_category(tmp_path, capsys):
    base = ["--project-path", str(tmp_path), "--action", "adjust"]
    assert run([*base, "--base-score", "5", "--adjusted-score", "8"]) == 1
    assert run([*base, "--category", "infra", "--base-score", "5"]) == 1
    assert (
        run(
            [*base, "--category", "infra", "--base-score", "0", "--adjusted-score", "8"]
        )
        == 1
    )
    assert (
        run(
            [
                *base,
                "--category",
                "infra",
                "--base-score",
                "5",
                "--adjusted-score",
                "14",
            ]
        )
        == 1
    )
    assert capsys.readouterr().out.count(ERROR_PREFIX) == 4
    assert load(tmp_path)["adjustments"] == []


def test_a_linked_calibration_folder_is_refused(tmp_path, capsys):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    (project / ".workpilot").symlink_to(elsewhere, target_is_directory=True)
    assert run(["--project-path", str(project), "--action", "reset"]) == 1
    assert "symbolic link" in capsys.readouterr().out
    assert not (elsewhere / RELATIVE.relative_to(".workpilot")).exists()


def test_the_runner_as_a_process(tmp_path):
    proc = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(tmp_path),
            "--action",
            "adjust",
            "--category",
            "infra",
            "--base-score",
            "3",
            "--adjusted-score",
            "4",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert _result(proc.stdout)["adjustments"] == 1


def test_a_category_outside_the_list_is_refused_by_argparse(tmp_path):
    proc = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(tmp_path),
            "--action",
            "adjust",
            "--category",
            "../x",
            "--base-score",
            "3",
            "--adjusted-score",
            "4",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert proc.returncode == 2
    assert not (tmp_path / RELATIVE).exists()
