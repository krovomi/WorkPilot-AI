"""The project index runner, as a server project's Context refresh starts it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "project_index_runner.py"


def _run(project: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )


def test_the_index_is_written_and_replaced(tmp_path: Path) -> None:
    project = tmp_path / "shop"
    project.mkdir()
    (project / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"react": "19.0.0"}}),
        encoding="utf-8",
    )
    index = project / ".workpilot" / "project_index.json"
    for _ in range(2):
        done = _run(project)
        assert done.returncode == 0, done.stderr
        assert done.stdout.splitlines() == [
            "Analyzing the project...",
            "Project index updated.",
        ]
        assert isinstance(json.loads(index.read_text(encoding="utf-8")), dict)
    assert [p.name for p in index.parent.iterdir()] == ["project_index.json"]


def test_a_missing_folder_is_refused(tmp_path: Path) -> None:
    done = _run(tmp_path / "gone")
    assert done.returncode == 2
    assert "Not a directory:" in done.stderr
