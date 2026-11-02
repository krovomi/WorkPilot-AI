"""The PR quality score runner: files of the project only, JSON out."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "quality_score_runner.py"
)


def _run(project: Path, *files: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), "--files", *files],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def _result(proc: subprocess.CompletedProcess[str]) -> dict:
    line = next(
        line for line in proc.stdout.splitlines() if line.startswith("QUALITY_RESULT:")
    )
    return json.loads(line.removeprefix("QUALITY_RESULT:"))


def test_scores_the_changed_files(tmp_path):
    (tmp_path / "ok.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    (tmp_path / "bad.py").write_text("def f(:\n", encoding="utf-8")
    proc = _run(tmp_path, "ok.py", "bad.py")
    assert proc.returncode == 0, proc.stderr
    score = _result(proc)
    assert score["critical_issues"] == 1
    assert score["issues"][0]["file"] == "bad.py"
    assert score["is_passing"] is False


def test_reads_nothing_outside_the_project(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (tmp_path / "secret.py").write_text("def f(:\n", encoding="utf-8")
    proc = _run(project, "../secret.py", str(tmp_path / "secret.py"), "missing.py")
    assert proc.returncode == 0, proc.stderr
    assert _result(proc)["total_issues"] == 0


def test_a_missing_project_is_an_error(tmp_path):
    proc = _run(tmp_path / "nope", "a.py")
    assert proc.returncode == 1
    assert proc.stdout.startswith("QUALITY_ERROR:")
