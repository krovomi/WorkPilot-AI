"""The ceilings a card's plan is measured against, and who set them.

A ceiling counts the lines a person will have to review (``review_load``),
and it depends on the kind of the task (``tasks.classify.TaskKind``): a hotfix
is read fast and in a hurry, a feature can fill one review session. The
defaults come from review studies (SmartBear on a Cisco team: past 200 to 400
lines, 500 lines an hour or 60 minutes, a reviewer finds fewer defects;
Google's guide: 100 lines is reasonable, 1000 too many). Investigations,
spikes and operations open no pull request to review and are never split.

The first source that says something wins:

1. the card (``task_metadata.json``): ``noSplit`` keeps it whole,
   ``splitMaxLines`` / ``splitMaxFiles`` replace the project's ceilings (and
   let a kind that is never split be split);
2. the project settings, which the desktop app sends as
   ``WORKPILOT_SPLIT_MAX_LINES_BY_KIND`` (a JSON object, kind to lines),
   ``WORKPILOT_SPLIT_MAX_LINES`` (every kind), ``WORKPILOT_SPLIT_MAX_FILES``
   and ``WORKPILOT_AUTO_SPLIT`` (``0`` turns splitting off); a server
   deployment sets the same variables;
3. the defaults below, by kind.

A value that is not a whole number in range is ignored, never clamped: a
ceiling of 3 lines would cut a plan into a card per subtask, so a typo falls
back to the next source instead of shaping the board.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

__all__ = [
    "DEFAULT_MAX_FILES",
    "DEFAULT_MAX_LINES",
    "DEFAULT_MAX_LINES_BY_KIND",
    "MAX_LINES_RANGE",
    "NEVER_SPLIT_KINDS",
    "SplitPolicy",
    "resolve_policy",
]

#: Lines to review per pull request, by kind of task.
DEFAULT_MAX_LINES_BY_KIND: dict[str, int] = {
    "hotfix": 100,  # read in a hurry, often in production
    "bug_fix": 200,  # the fix and its test
    "feature": 400,  # one review session at most
    "refactoring": 300,  # behaviour must not move: subtle to check
    "upgrade": 200,  # lockfiles weigh nothing; the adapted code is the risk
    "test": 400,  # about 800 lines of tests, which weigh half
    "docs": 400,  # about 800 lines of prose, which weigh half
}
#: The ceiling of a kind the table does not name.
DEFAULT_MAX_LINES = DEFAULT_MAX_LINES_BY_KIND["feature"]
#: Kinds whose work is no code to review: never split unless the card says so.
NEVER_SPLIT_KINDS = frozenset({"investigation", "spike", "run"})
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
    #: The kind of task the ceiling was chosen for.
    kind: str = "feature"


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


def _kind_table(raw: Any) -> dict[str, int]:
    """The project's ceilings by kind, from its JSON; bad entries dropped."""
    if not raw:
        return {}
    try:
        table = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {}
    if not isinstance(table, dict):
        return {}
    out: dict[str, int] = {}
    for key, value in table.items():
        lines = _whole(value, MAX_LINES_RANGE)
        if isinstance(key, str) and lines is not None:
            out[key] = lines
    return out


def resolve_policy(
    metadata: Mapping[str, Any] | None,
    env: Mapping[str, str] | None = None,
    kind: str | None = None,
) -> SplitPolicy:
    """The policy for one card of ``kind`` (default: the card's ``kind``)."""
    metadata = metadata or {}
    env = os.environ if env is None else env
    kind = str(kind or metadata.get("kind") or "feature").strip().lower()
    card_lines = _whole(metadata.get("splitMaxLines"), MAX_LINES_RANGE)
    enabled = metadata.get("noSplit") is not True and (
        str(env.get("WORKPILOT_AUTO_SPLIT", "1")).strip().lower()
        not in {"0", "false", "off", "no"}
    )
    if kind in NEVER_SPLIT_KINDS and card_lines is None:
        enabled = False
    by_kind = _kind_table(env.get("WORKPILOT_SPLIT_MAX_LINES_BY_KIND"))
    project_lines = _whole(env.get("WORKPILOT_SPLIT_MAX_LINES"), MAX_LINES_RANGE)
    card_files = _whole(metadata.get("splitMaxFiles"), MAX_FILES_RANGE)
    project_files = _whole(env.get("WORKPILOT_SPLIT_MAX_FILES"), MAX_FILES_RANGE)
    if card_lines is not None:
        lines, source = card_lines, "card"
    elif kind in by_kind:
        lines, source = by_kind[kind], "project"
    elif project_lines is not None:
        lines, source = project_lines, "project"
    else:
        lines = DEFAULT_MAX_LINES_BY_KIND.get(kind, DEFAULT_MAX_LINES)
        source = "default"
    files = card_files or project_files or DEFAULT_MAX_FILES
    return SplitPolicy(enabled, lines, files, source, kind)
