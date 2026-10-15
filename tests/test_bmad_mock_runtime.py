"""The committed `_bmad/` stand-in: a mock that says so and fails (F50)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MOCK = REPO_ROOT / "_bmad" / "scripts" / "resolve_customization.py"


def test_the_committed_runtime_is_marked_as_a_mock():
    from skills_registry.resolver import is_mock_runtime

    assert MOCK.is_file()
    assert is_mock_runtime(MOCK)


def test_the_mock_fails_on_invocation():
    # A skill's first step runs it and reads `customize.toml` "on failure":
    # an exit code of 0 with no data would silence that fallback.
    run = subprocess.run(
        [
            sys.executable,
            str(MOCK),
            "--skill",
            "x",
            "--project-root",
            ".",
            "--key",
            "workflow",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 2
    assert "mock" in run.stderr.lower()
    assert run.stdout == ""
