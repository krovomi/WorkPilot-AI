"""What a goal is, read from the file only the user writes.

A goal is a command and the exit code that means "done". It lives in
``<spec>/.workpilot-goal.json``, not in ``task_metadata.json``: the agents can
write the task metadata, and a goal an agent could rewrite would let it
declare itself done with ``true``. The file name is in
``security.path_guard.PROTECTED_CONFIG_NAMES``, so the write hook, the
non-SDK executor and the Bash validator refuse it to every agent; only the
main process writes it, from the task's goal card (in server mode, the API, from
``PATCH /api/board/cards/{id}/settings``: ``shared_board/settings.py``).

A file that is there but does not parse is an error, never "no goal": the
user asked for a check, and a typo must not switch it off.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path

__all__ = [
    "GOAL_FILENAME",
    "GoalConfigError",
    "GoalSpec",
    "goal_file",
    "load_goal",
    "parse_goal",
]

GOAL_FILENAME = ".workpilot-goal.json"

MAX_COMMAND_CHARS = 4096
MIN_TIMEOUT_S = 10
MAX_TIMEOUT_S = 7200
DEFAULT_TIMEOUT_S = 600
MAX_ROUNDS = 50
MAX_COST_USD = 10_000.0
MAX_PROTECTED = 64
MAX_PATTERN_CHARS = 512


class GoalConfigError(ValueError):
    """The goal file exists and says something that cannot be checked."""


@dataclass(frozen=True)
class GoalSpec:
    command: str
    """One command line, run without a shell (``foundation.platform.split_command``)."""
    expected_exit: int = 0
    timeout_s: int = DEFAULT_TIMEOUT_S
    max_rounds: int | None = None
    """QA passes this goal may spend; None keeps the effort-based cap."""
    max_cost_usd: float | None = None
    """What the whole task may spend, all phases; None is no cap."""
    protected: tuple[str, ...] = ()
    """Paths (globs, relative to the repository) the task may not change."""

    def to_dict(self) -> dict:
        data = asdict(self)
        data["protected"] = list(self.protected)
        return data


def _int(raw, name: str, low: int, high: int) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise GoalConfigError(f"{name} must be a whole number")
    if not low <= raw <= high:
        raise GoalConfigError(f"{name} must be between {low} and {high}")
    return raw


def _pattern(raw) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise GoalConfigError("a protected path must be a non-empty string")
    pattern = raw.strip().replace("\\", "/")
    if len(pattern) > MAX_PATTERN_CHARS or "\0" in pattern:
        raise GoalConfigError("a protected path is too long")
    if pattern.startswith("/") or (len(pattern) > 1 and pattern[1] == ":"):
        raise GoalConfigError(
            f"protected path {raw!r} must be relative to the repository"
        )
    if ".." in pattern.split("/"):
        raise GoalConfigError(f"protected path {raw!r} may not contain '..'")
    return pattern


def parse_goal(raw) -> GoalSpec:
    """A goal from its JSON form. Raises ``GoalConfigError``."""
    if not isinstance(raw, dict):
        raise GoalConfigError("the goal must be a JSON object")
    command = raw.get("command")
    if not isinstance(command, str) or not command.strip():
        raise GoalConfigError("the goal has no command")
    command = command.strip()
    if len(command) > MAX_COMMAND_CHARS or "\0" in command or "\n" in command:
        raise GoalConfigError("the goal command must be one line")

    expected = raw.get("expectedExit", 0)
    timeout = raw.get("timeoutSeconds", DEFAULT_TIMEOUT_S)
    rounds = raw.get("maxRounds")
    cost = raw.get("maxCostUsd")
    protected = raw.get("protected") or []

    if cost is not None:
        if isinstance(cost, bool) or not isinstance(cost, int | float):
            raise GoalConfigError("maxCostUsd must be a number")
        if not math.isfinite(cost) or not 0 < cost <= MAX_COST_USD:
            raise GoalConfigError(
                f"maxCostUsd must be above 0 and at most {MAX_COST_USD:g}"
            )
    if not isinstance(protected, list) or len(protected) > MAX_PROTECTED:
        raise GoalConfigError(
            f"protected must be a list of at most {MAX_PROTECTED} paths"
        )

    return GoalSpec(
        command=command,
        expected_exit=_int(expected, "expectedExit", 0, 255),
        timeout_s=_int(timeout, "timeoutSeconds", MIN_TIMEOUT_S, MAX_TIMEOUT_S),
        max_rounds=None if rounds is None else _int(rounds, "maxRounds", 1, MAX_ROUNDS),
        max_cost_usd=None if cost is None else float(cost),
        protected=tuple(dict.fromkeys(_pattern(p) for p in protected)),
    )


def goal_file(spec_dir: Path | str) -> Path:
    return Path(spec_dir) / GOAL_FILENAME


def load_goal(*spec_dirs: Path | str | None) -> GoalSpec | None:
    """The goal of the first spec directory that has one, or None.

    Callers pass the main project's spec directory first: that is where the
    card writes, while a worktree holds the copy made when it was created.
    Raises ``GoalConfigError`` for a file that is there and unreadable.
    """
    for spec_dir in spec_dirs:
        if spec_dir is None:
            continue
        path = goal_file(spec_dir)
        if path.is_symlink():
            raise GoalConfigError(f"{GOAL_FILENAME} is a symbolic link")
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise GoalConfigError(f"{GOAL_FILENAME} cannot be read: {exc}") from exc
        return parse_goal(raw)
    return None
