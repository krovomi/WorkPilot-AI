"""The ceilings a card's plan is measured against, and who set them.

Three sources, the first one that says something wins:

1. the card (``task_metadata.json``): ``noSplit`` keeps it whole,
   ``splitMaxLines`` / ``splitMaxFiles`` replace the project's ceilings;
2. the project settings, which the desktop app sends as
   ``WORKPILOT_AUTO_SPLIT`` (``0`` turns splitting off),
   ``WORKPILOT_SPLIT_MAX_LINES`` and ``WORKPILOT_SPLIT_MAX_FILES``; a server
   deployment sets the same variables;
3. the defaults below.

A value that is not a whole number in range is ignored, never clamped: a
ceiling of 3 lines would cut a plan into a card per subtask, so a typo falls
back to the next source instead of shaping the board.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

__all__ = [
    "DEFAULT_MAX_FILES",
    "DEFAULT_MAX_LINES",
    "MAX_LINES_RANGE",
    "SplitPolicy",
    "resolve_policy",
]

#: Lines changed per pull request. Review studies put the drop in found
#: defects between 200 and 400 changed lines; 400 is the upper end.
DEFAULT_MAX_LINES = 400
#: Files per pull request: a second bound for plans that touch many files a
#: little (renames, imports), which a line count alone lets through.
DEFAULT_MAX_FILES = 25
MAX_LINES_RANGE = (50, 20_000)
MAX_FILES_RANGE = (2, 1_000)


@dataclass(frozen=True)
class SplitPolicy:
    enabled: bool
    max_lines: int
    max_files: int
    #: ``card``, ``project`` or ``default``: where ``max_lines`` came from.
    source: str = "default"


def _whole(value: Any, bounds: tuple[int, int]) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value.isdigit():
            return None
        value = int(value)
    if not isinstance(value, int):
        return None
    low, high = bounds
    return value if low <= value <= high else None


def resolve_policy(
    metadata: Mapping[str, Any] | None, env: Mapping[str, str] | None = None
) -> SplitPolicy:
    """The policy for one card."""
    metadata = metadata or {}
    env = os.environ if env is None else env
    enabled = metadata.get("noSplit") is not True and (
        str(env.get("WORKPILOT_AUTO_SPLIT", "1")).strip().lower()
        not in {"0", "false", "off", "no"}
    )
    card_lines = _whole(metadata.get("splitMaxLines"), MAX_LINES_RANGE)
    project_lines = _whole(env.get("WORKPILOT_SPLIT_MAX_LINES"), MAX_LINES_RANGE)
    card_files = _whole(metadata.get("splitMaxFiles"), MAX_FILES_RANGE)
    project_files = _whole(env.get("WORKPILOT_SPLIT_MAX_FILES"), MAX_FILES_RANGE)
    if card_lines is not None:
        lines, source = card_lines, "card"
    elif project_lines is not None:
        lines, source = project_lines, "project"
    else:
        lines, source = DEFAULT_MAX_LINES, "default"
    files = card_files or project_files or DEFAULT_MAX_FILES
    return SplitPolicy(enabled, lines, files, source)
