"""The approval policy of a project, and the mode it runs in.

Two switches decide the mode, and the stricter one wins:

- the app setting, which the Electron main passes as ``WORKPILOT_APPROVALS``
  (``off`` / ``observe`` / ``enforce``; ``observe`` when unset): one switch
  for every project, so the feature can be turned off whole;
- the ``mode`` of the repository's ``approvals`` section, which can only
  restrict it: a project can stay in ``observe`` when the app enforces, never
  enforce when the app observes.

The file is read from the main checkout, never from a task's worktree where
an agent could edit it (``guardrail_policy.main_project``).
"""

from __future__ import annotations

import os
from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml
from security.guardrail_policy import REPO_POLICY_NAMES, main_project

from .model import MODE_ENFORCE, MODE_OBSERVE, MODE_OFF, MODES
from .policy import ApprovalPolicy, glob_list, parse_approvals

ENV_MODE = "WORKPILOT_APPROVALS"
_ORDER = {MODE_OFF: 0, MODE_OBSERVE: 1, MODE_ENFORCE: 2}


def app_mode(env: dict[str, str] | None = None) -> str:
    """The app setting; an unknown value is ``observe``, never ``enforce``."""
    value = (env if env is not None else os.environ).get(ENV_MODE, "").strip().lower()
    return value if value in MODES else MODE_OBSERVE


def effective_mode(app: str, file_mode: str) -> str:
    """The stricter of the app setting and the file's own mode."""
    if file_mode not in MODES:
        return app
    return min(app, file_mode, key=lambda m: _ORDER[m])


def _document(project: Path) -> tuple[dict[str, Any] | None, str, str | None]:
    for name in REPO_POLICY_NAMES:
        path = project / name
        if not path.is_file():
            continue
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, yaml.YAMLError) as exc:
            return None, name, f"{name}: cannot be read ({exc})"
        if data is None:
            return {}, name, None
        if not isinstance(data, dict):
            return None, name, f"{name}: the document must be a mapping"
        return data, name, None
    return None, "", None


def load_approval_policy(
    root: Path, env: dict[str, str] | None = None
) -> ApprovalPolicy:
    """The policy for ``root`` (a project or one of its worktrees). Never raises."""
    project = main_project(Path(root))
    data, name, error = _document(project)
    mode = app_mode(env)
    if error:
        return ApprovalPolicy(mode=mode, source=name, declared=True, errors=(error,))
    errors: list[str] = []
    files = (data or {}).get("files")
    requires_review = tuple(
        glob_list(files.get("requires_review"), "files.requires_review", 200, errors)
        if isinstance(files, dict)
        else ()
    )
    policy = parse_approvals(data, source=name, requires_review=requires_review)
    return replace(
        policy,
        mode=effective_mode(mode, policy.mode),
        errors=policy.errors + tuple(errors),
    )


__all__ = ["ENV_MODE", "app_mode", "effective_mode", "load_approval_policy"]
