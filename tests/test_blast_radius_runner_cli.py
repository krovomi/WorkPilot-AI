"""The Blast Radius runner, as the desktop app starts it (backend on PYTHONPATH)."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "blast_radius_runner.py"


def _run(root: Path, targets: str) -> tuple[int, dict]:
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-root",
            str(root),
            "--targets",
            targets,
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONPATH": str(BACKEND)},
        timeout=120,
        check=False,
    )
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "tests").mkdir(parents=True)
    (root / "prices.py").write_text("RATE = 2\n", encoding="utf-8")
    (root / "cart.py").write_text("import prices\n", encoding="utf-8")
    (root / "tests" / "test_cart.py").write_text("import prices\n", encoding="utf-8")
    return root


def test_the_files_that_import_a_target_are_its_blast_radius(shop: Path) -> None:
    code, report = _run(shop, " prices.py , ,")
    assert code == 0
    assert report["targets"] == ["prices.py"]
    assert sorted(d["source"] for d in report["dependents"]) == [
        "cart.py",
        "tests/test_cart.py",
    ]
    assert report["tests"] == ["tests/test_cart.py"]
    assert report["total_dependents"] == 2


def test_a_target_that_is_not_a_file_has_no_radius(shop: Path) -> None:
    code, report = _run(shop, "missing.py")
    assert code == 0
    assert report["explanation"] == ["no valid target files"]


def test_a_failing_analysis_ends_with_an_error_line(
    shop: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("blast_radius_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def boom(_root, _targets):
        raise OSError("disk gone")

    monkeypatch.setattr(module, "analyze_blast_radius", boom)
    monkeypatch.setattr(
        sys, "argv", ["runner", "--project-root", str(shop), "--targets", "prices.py"]
    )
    assert module.main() == 1
    assert json.loads(capsys.readouterr().out) == {"error": "disk gone"}
