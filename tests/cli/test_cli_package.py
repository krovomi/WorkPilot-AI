"""`python -m cli.main`, the way the desktop app starts the CLI.

The lazy `from cli import main` is covered by `tests/test_startup_log_noise.py`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def test_python_dash_m_runs_the_cli_without_a_runpy_warning():
    # Run from the backend directory with nothing else on the path, the way
    # the desktop app starts the streaming server: the CLI has to find the
    # repository's shared `src/` package on its own.
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "PYTHONWARNINGS"}
    }
    env["PYTHONUTF8"] = "1"

    result = subprocess.run(
        [sys.executable, "-W", "error::RuntimeWarning", "-m", "cli.main", "--help"],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout
    assert "--spec SPEC" in result.stdout
    assert "RuntimeWarning" not in result.stderr
