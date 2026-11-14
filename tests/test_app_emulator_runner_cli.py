"""The App Emulator runner, as the Kanban preview starts it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "app_emulator_runner.py"
MARKER = "__APP_EMULATOR_RESULT__:"


def _run(project: Path) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    [line] = [ln for ln in done.stdout.splitlines() if ln.startswith(MARKER)]
    return done.returncode, json.loads(line[len(MARKER) :])


def test_a_vite_project_is_detected(tmp_path: Path) -> None:
    project = tmp_path / "web"
    project.mkdir()
    (project / "package.json").write_text(
        json.dumps({"scripts": {"dev": "vite"}, "devDependencies": {"vite": "7.0.0"}}),
        encoding="utf-8",
    )
    code, result = _run(project)
    assert code == 0 and result["success"] is True
    assert "dev" in result["startCommand"]


def test_a_missing_folder_is_refused(tmp_path: Path) -> None:
    code, result = _run(tmp_path / "gone")
    assert code == 1
    assert result["success"] is False
    assert result["error"].startswith("Directory not found:")
