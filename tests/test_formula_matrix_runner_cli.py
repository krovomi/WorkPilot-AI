"""The Formula Matrix runner, as the Formula Lab starts it."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "formula_matrix_runner.py"


def _run(*args: str) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


def test_the_formulas_of_a_ticket_are_computed(tmp_path: Path) -> None:
    project = tmp_path / "shop"
    spec = project / ".workpilot" / "specs" / "001-cart"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps({"subtasks": [{"files": ["cart.py"]}, {"files": ["tax.py"]}]}),
        encoding="utf-8",
    )
    code, out = _run(
        "--ticket-id",
        "001-cart",
        "--description",
        "Fix the cart total",
        "--project-root",
        str(project),
        "--spec-dir",
        str(spec),
        "--providers",
        "anthropic, ,",
        "--complexity",
        "3",
    )
    assert code == 0
    matrix = out["matrix"]
    assert matrix["ticket_id"] == "001-cart"
    assert matrix["complexity_score"] == 3.0
    assert matrix["footprint"]["subtask_count"] == 2
    assert matrix["formulas"]
    assert {f["provider"] for f in matrix["formulas"]} == {"anthropic"}


def test_a_ticket_alone_uses_every_provider() -> None:
    code, out = _run("--ticket-id", "T1", "--providers", " , ")
    assert code == 0
    assert len({f["provider"] for f in out["matrix"]["formulas"]}) > 1


def test_a_failing_computation_ends_with_an_error_line(monkeypatch, capsys) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("formula_matrix_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def boom(**_kwargs):
        raise ValueError("no pricing table")

    monkeypatch.setattr(module, "discover_local_models", lambda: [])
    monkeypatch.setattr(module, "compute_formula_matrix", boom)
    monkeypatch.setattr(sys, "argv", ["runner", "--ticket-id", "T1"])
    with pytest.raises(SystemExit) as stop:
        module.main()
    assert stop.value.code == 1
    assert json.loads(capsys.readouterr().out) == {"error": "no pricing table"}
