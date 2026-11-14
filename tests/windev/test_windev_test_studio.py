"""The test studio on a WinDev project says it cannot help, instead of writing pytest.

A WinDev test is a test scenario only the editor creates and runs
(docs/architecture/windev.md). Before, a WinDev project without a source
file fell back to Python.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from tests.windev.samples import procedure_set, project_file

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def _errors(*args: str) -> list[dict]:
    out = subprocess.run(
        [sys.executable, str(BACKEND / "runners" / "test_generation_runner.py"), *args],
        capture_output=True,
        text=True,
        cwd=str(BACKEND),
        timeout=120,
    ).stdout
    return [
        json.loads(line[len("__TG_ERROR__:") :])
        for line in out.splitlines()
        if line.startswith("__TG_ERROR__:")
    ]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "Gestion.wdp").write_text(project_file(), encoding="utf-8")
    (tmp_path / "COL_Clients.wdg").write_text(procedure_set(), encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize(
    "action", ["generate-tdd", "generate-e2e", "resolve-libraries"]
)
def test_a_windev_project_without_a_source_is_refused(project: Path, action: str):
    (error,) = _errors("--action", action, "--project-path", str(project))
    assert error["code"] == "unsupported_stack"
    assert "WinDev editor" in error["message"]


def test_a_windev_source_file_is_refused(project: Path):
    (error,) = _errors(
        "--action",
        "generate-unit",
        "--file-path",
        str(project / "COL_Clients.wdg"),
        "--project-path",
        str(project),
    )
    assert error["code"] == "unsupported_stack"


def test_a_language_the_person_picks_still_wins(project: Path):
    from runners.test_generation_runner import _windev_refusal

    class Args:
        file_path = None
        target_module = None
        language = "csharp"
        project_path = str(project)

    assert _windev_refusal(Args) is None
    Args.language = None
    assert _windev_refusal(Args) is not None
    Args.file_path = str(project / "api" / "Service.cs")
    assert _windev_refusal(Args) is None
