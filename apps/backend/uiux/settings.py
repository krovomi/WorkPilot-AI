"""The questions a user gets to answer about ui-ux-pro-max, and where.

Same shape as `rtk.settings`: read from the environment and from
`.workpilot/.env`, because that file is what the Settings screen writes and a
switch that only reaches the CLI is a switch half the product cannot see. Real
environment variables win over the file.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "ENABLED_ENV",
    "PERSIST_ENV",
    "MAX_GUIDELINES_ENV",
    "SETTINGS_KEYS",
    "is_enabled",
    "persist_master",
    "max_guidelines",
    "read_settings",
]

#: Master switch. On by default because "on" costs nothing on a task that does
#: not touch the interface: relevance is answered from paths before anything
#: runs, and a backend task gets no section, no tool and no file.
ENABLED_ENV = "UIUX_ENABLED"

#: Whether a generated design system is written into the worktree as
#: `design-system/<project>/MASTER.md` (upstream's own convention). On by
#: default: a design system that lives only in the spec directory is one the
#: next task regenerates differently.
PERSIST_ENV = "UIUX_PERSIST_MASTER"

#: Stack guidelines put in front of the coder. Each costs ~120 tokens, and the
#: section is read on every UI subtask, by local models too.
MAX_GUIDELINES_ENV = "UIUX_MAX_GUIDELINES"

SETTINGS_KEYS = (ENABLED_ENV, PERSIST_ENV, MAX_GUIDELINES_ENV)

_DEFAULT_MAX_GUIDELINES = 5


def _truthy(value: object, default: bool) -> bool:
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def _project_env(project_dir: Path | str | None) -> dict[str, str]:
    if not project_dir:
        return {}
    path = Path(project_dir) / ".workpilot" / ".env"
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


def read_settings(project_dir: Path | str | None = None) -> dict[str, str]:
    """The project's file, overlaid by the real environment."""
    values = _project_env(project_dir)
    for key in SETTINGS_KEYS:
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def is_enabled(project_dir: Path | str | None = None) -> bool:
    return _truthy(read_settings(project_dir).get(ENABLED_ENV, "true"), True)


def persist_master(project_dir: Path | str | None = None) -> bool:
    return _truthy(read_settings(project_dir).get(PERSIST_ENV, "true"), True)


def max_guidelines(project_dir: Path | str | None = None) -> int:
    """A nonsense value falls back to the default rather than to zero: a knob
    documented as a count must not become the way to switch the feature off."""
    raw = read_settings(project_dir).get(MAX_GUIDELINES_ENV, "")
    try:
        value = int(str(raw).strip())
    except ValueError:
        return _DEFAULT_MAX_GUIDELINES
    return value if 1 <= value <= 20 else _DEFAULT_MAX_GUIDELINES
