"""The two questions a user gets to answer about rtk, and where they answer them.

Same shape as `libdocs.preflight`: the switch is read from the environment and
from `.workpilot/.env`, because that file is what the Electron settings screen
writes and a toggle that only reaches the CLI is a toggle half the product
cannot see. Real environment variables win over the file — a CLI user who
exported something should not be overridden by a stale line on disk.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "ENABLED_ENV",
    "MODEL_FACING_ENV",
    "SETTINGS_KEYS",
    "is_enabled",
    "model_facing_enabled",
    "project_env",
]

#: Master switch. On by default, because "on" costs nothing on a machine
#: without rtk: every entry point answers "not installed" before doing work.
ENABLED_ENV = "RTK_ENABLED"

#: The narrower switch: whether WorkPilot routes *its own* captures — the
#: `git diff` it puts in a prompt, the test output it hands a reviewer —
#: through rtk. Separate from the master switch because the two carry
#: different risk. Rewriting an agent's Bash command changes what a model
#: reads and nothing else; condensing a capture changes what a WorkPilot code
#: path receives, and a caller that parses its own output must never get one.
MODEL_FACING_ENV = "RTK_MODEL_FACING"

SETTINGS_KEYS = (ENABLED_ENV, MODEL_FACING_ENV, "WORKPILOT_RTK_PATH")

_WORKPILOT_DIR = ".workpilot"


def _truthy(value: object, default: bool) -> bool:
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def is_enabled(env: dict | None = None) -> bool:
    """Whether rtk may be used at all in this process."""
    source = os.environ if env is None else env
    return _truthy(source.get(ENABLED_ENV, "true"), True)


def model_facing_enabled(env: dict | None = None) -> bool:
    """Whether WorkPilot's own model-facing captures go through rtk."""
    source = os.environ if env is None else env
    return is_enabled(source) and _truthy(source.get(MODEL_FACING_ENV, "true"), True)


def project_env(project_dir: Path | str) -> dict[str, str]:
    """The rtk settings a project carries in `.workpilot/.env`."""
    path = Path(project_dir) / _WORKPILOT_DIR / ".env"
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip()
        if key in SETTINGS_KEYS:
            values[key] = raw.strip().strip("\"'")
    return values


def apply_project_env(project_dir: Path | str) -> dict[str, str]:
    """Fold a project's `.workpilot/.env` rtk keys into `os.environ`.

    Only keys the environment does not already carry: an exported value is a
    decision made later than a file, and the file is the default it overrides.
    Returns what was applied, so a caller can say so.
    """
    applied: dict[str, str] = {}
    for key, value in project_env(project_dir).items():
        if key not in os.environ:
            os.environ[key] = value
            applied[key] = value
    return applied
