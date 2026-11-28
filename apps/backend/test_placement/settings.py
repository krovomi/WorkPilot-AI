"""What the person decided about where a task's long suites run.

Same shape as ``verify.settings``: each knob is read from the environment and
from the project's ``.workpilot/.env``, and a real environment variable wins
over the file. ``WORKPILOT_TEST_PLACEMENT`` is the card's own choice, set by
the app on the build's environment; ``TEST_PLACEMENT`` is the project default.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "BRANCH_PUSH_ENV",
    "MODES",
    "PROJECT_ENV",
    "ROUTES",
    "ROUTES_ENV",
    "TASK_ENV",
    "PlacementSettings",
    "load_settings",
]

TASK_ENV = "WORKPILOT_TEST_PLACEMENT"
PROJECT_ENV = "TEST_PLACEMENT"
BRANCH_PUSH_ENV = "TEST_PLACEMENT_ALLOW_BRANCH_PUSH"
#: The routes off this machine the app will carry out after the build (push the
#: branch and follow its pipeline, hand the suite to the server). Set by the
#: app on the build's environment only: a route nobody follows would be a
#: suite nobody runs, so without it every suite stays here.
ROUTES_ENV = "WORKPILOT_TEST_PLACEMENT_ROUTES"
ROUTES = ("ci", "server")
_KEYS = (TASK_ENV, PROJECT_ENV, BRANCH_PUSH_ENV)

#: ``auto`` computes; ``machine`` and ``ci`` are the manual choices.
MODES = ("auto", "machine", "ci")


@dataclass(frozen=True)
class PlacementSettings:
    mode: str = "auto"
    #: Auto may push the task's branch without a PR to run the forge's CI.
    #: The app says yes when the project has a CI and its setting allows it;
    #: absent, nothing is pushed.
    allow_branch_push: bool = False
    #: What the app follows off this machine (``ROUTES``).
    routes: frozenset[str] = frozenset()
    #: Where ``mode`` came from: ``task``, ``project`` or ``default``.
    decided_by: str = "default"


def _project_file(project_dir: Path | str | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if not project_dir:
        return values
    path = Path(project_dir) / ".workpilot" / ".env"
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
        if key in _KEYS:
            values[key] = raw.strip().strip("\"'")
    return values


def _mode(value: object) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in MODES else None


def _truthy(value: object) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _routes(value: object) -> frozenset[str]:
    names = {part.strip().lower() for part in str(value or "").split(",")}
    return frozenset(name for name in names if name in ROUTES)


def load_settings(
    project_dir: Path | str | None = None, env: Mapping[str, str] | None = None
) -> PlacementSettings:
    """The effective settings: environment over ``.workpilot/.env`` over defaults.

    A value outside the closed list is the default, never a choice: a typo
    cannot move a suite off the machine.
    """
    environ = os.environ if env is None else env
    merged = _project_file(project_dir)
    for key in _KEYS:
        if key in environ:
            merged[key] = str(environ[key])

    task = _mode(merged.get(TASK_ENV))
    project = _mode(merged.get(PROJECT_ENV))
    if task:
        mode, decided_by = task, "task"
    elif project:
        mode, decided_by = project, "project"
    else:
        mode, decided_by = "auto", "default"
    return PlacementSettings(
        mode=mode,
        allow_branch_push=_truthy(merged.get(BRANCH_PUSH_ENV)),
        routes=_routes(environ.get(ROUTES_ENV)),
        decided_by=decided_by,
    )
