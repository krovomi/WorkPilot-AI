"""The Tech Debt runner, as the desktop app starts it, on a real project.

`scan` finds the debt and saves the report under `.workpilot/tech_debt/`;
`list`, `trend` and `spec` read that saved report.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "tech_debt_runner.py"


def _run(project: Path, *args: str) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    [line] = done.stdout.splitlines()
    return done.returncode, json.loads(line)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "cart.py").write_text(
        "def total():\n    # TODO: remove this hack\n    return 1\n", encoding="utf-8"
    )
    return root


def test_a_scan_is_saved_then_listed_and_turned_into_a_spec(project: Path) -> None:
    code, out = _run(project, "--command", "scan")
    assert code == 0
    [item] = out["result"]["items"]
    assert (item["kind"], item["file_path"], item["line"]) == (
        "todo_fixme",
        "cart.py",
        2,
    )
    assert out["result"]["summary"]["total"] == 1
    assert (project / ".workpilot" / "tech_debt" / "last_report.json").is_file()

    code, out = _run(project, "--command", "list")
    assert code == 0 and [i["id"] for i in out["result"]["items"]] == [item["id"]]
    assert out["result"]["summary"]["by_kind"] == {"todo_fixme": 1}

    code, out = _run(project, "--command", "list", "--min-score", "99")
    assert code == 0 and out["result"]["items"] == []

    code, out = _run(project, "--command", "trend")
    assert code == 0 and [t["total_items"] for t in out["result"]["trend"]] == [1]

    code, out = _run(
        project,
        "--command",
        "spec",
        "--item-id",
        item["id"],
        "--llm-hint",
        "Inline the constant.",
    )
    assert code == 0
    spec_dir = Path(out["result"]["spec_dir"])
    assert spec_dir.name.startswith("001-tech-debt-remove-this-hack")
    spec = (spec_dir / "spec.md").read_text(encoding="utf-8")
    assert "remove this hack" in spec and "Inline the constant." in spec


def test_a_project_never_scanned_has_an_empty_list(project: Path) -> None:
    assert _run(project, "--command", "list") == (
        0,
        {"result": {"items": [], "trend": [], "summary": {}}},
    )
    assert _run(project, "--command", "trend") == (0, {"result": {"trend": []}})


def test_an_unknown_item_has_no_spec(project: Path) -> None:
    _run(project, "--command", "scan")
    assert _run(project, "--command", "spec", "--item-id", "nope") == (
        1,
        {"error": "item not found: nope"},
    )


def test_a_broken_report_ends_with_an_error(project: Path) -> None:
    saved = project / ".workpilot" / "tech_debt"
    saved.mkdir(parents=True)
    (saved / "last_report.json").write_text("{broken", encoding="utf-8")
    code, out = _run(project, "--command", "list")
    assert code == 1 and "Expecting property name" in out["error"]
