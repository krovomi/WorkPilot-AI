"""The Cost Predictor runner, as the desktop app starts it, on a real spec."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "cost_predictor_runner.py"


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
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


def _spec(project: Path, root: str, name: str, plan: object) -> None:
    spec = project / root / "specs" / name
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    _spec(
        root,
        ".workpilot",
        "001-cart",
        {"subtasks": [{"files": ["cart.py", "prices.py"], "estimated_loc": 40}]},
    )
    return root


def test_a_spec_of_the_project_is_priced(project: Path) -> None:
    code, out = _run(
        project,
        "--spec-id",
        "001-cart",
        "--compare",
        "openai:gpt-5, claude-haiku-4-5,",
        "--no-thinking",
    )
    assert code == 0
    report = out["report"]
    assert report["spec_id"] == "001-cart"
    assert report["footprint"]["touched_files"] == 2
    assert report["footprint"]["loc_in_scope"] == 40
    assert report["selected"]["expected_thinking_tokens"] == 0
    assert [(a["provider"], a["model"]) for a in report["alternatives"]] == [
        ("openai", "gpt-5"),
        ("anthropic", "claude-haiku-4-5"),
    ]


def test_a_spec_from_before_the_rename_is_found(project: Path) -> None:
    _spec(project, ".autonomousbuild", "002-old", {"subtasks": [{"files": ["a"]}]})
    code, out = _run(project, "--spec-id", "002-old")
    assert code == 0 and out["report"]["spec_id"] == "002-old"


@pytest.mark.parametrize("spec_id", ["003-none", "..", "../../..", "001-cart/.."])
def test_only_a_spec_folder_of_the_project_is_read(project: Path, spec_id) -> None:
    assert _run(project, "--spec-id", spec_id) == (
        1,
        {"error": f"Spec not found: {spec_id}"},
    )


def test_a_plan_the_predictor_cannot_read_ends_with_an_error(project: Path) -> None:
    _spec(project, ".workpilot", "004-odd", {"subtasks": ["not a subtask"]})
    code, out = _run(project, "--spec-id", "004-odd")
    assert code == 1 and "get" in out["error"]
