"""The running interpreter, named as the command allowlist knows it.

A venv's `pytest` script runs as `python3.12`, and the allowlist knows `python`:
a test that ran `sys.executable` as a command passed only under
`python -m pytest`, and failed under `pytest` (the pre-commit hook included).
"""

import sys
from pathlib import Path


def allowlisted_python() -> str:
    """`python` (`python.exe`) beside the running interpreter, when there is one."""
    executable = Path(sys.executable)
    suffix = ".exe" if executable.suffix.lower() == ".exe" else ""
    candidate = executable.with_name(f"python{suffix}")
    return str(candidate) if candidate.exists() else sys.executable
