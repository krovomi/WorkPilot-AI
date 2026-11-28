"""The execution-wave plan of a server project's backlog, from its clone.

The cards are the clone's ``.workpilot/specs/<card>`` (the build workspace's
copy while a build runs, ``shared_board.listing.card_source``); a card's
footprint is the files its plan declares ∪ the files its workspace changed.
Every file read here is a regular file, not a link, under its size; every
path resolves inside the clone. Options are validated by ``WaveOptions``
before anything is read; the client never names a path.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import git_reads
from .merge_check import plan_with_merge_checks
from .planner import MergeOutcome, PlannerOptions, PlannerTask, plan_execution_waves
from .scorer import build_footprint

#: Columns a plan may schedule (not started yet), and those of a running build.
PLANNABLE = frozenset({"backlog", "queue"})
RUNNING = frozenset({"in_progress", "ai_review"})
PRIORITY_WEIGHT = {"urgent": 4, "high": 3, "medium": 2, "low": 1}
MAX_PLAN_TASKS = 200
MAX_PARALLEL_CEILING = 32
DEFAULT_MAX_PARALLEL = 3
MAX_JSON_BYTES = 2_000_000
MAX_TITLE = 200


@dataclass(frozen=True)
class WaveOptions:
    """What a client may set; validated by the route (bounds, closed lists)."""

    tolerance: float = 0
    unplanned_policy: str = "isolate"
    drift_threshold: float = 3
    fragile_zones: bool = True
    code_links: bool = True
    max_parallel: int = DEFAULT_MAX_PARALLEL

    def as_dict(self) -> dict[str, Any]:
        return {
            "tolerance": self.tolerance,
            "unplannedPolicy": self.unplanned_policy,
            "driftThreshold": self.drift_threshold,
            "fragileZones": self.fragile_zones,
            "codeLinks": self.code_links,
            "maxParallel": self.max_parallel,
        }


MAX_TOLERANCE = 100
MAX_DRIFT_THRESHOLD = 1_000
POLICIES = frozenset({"isolate", "independent"})


def _number(value: Any, fallback: float, ceiling: float) -> float | None:
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if 0 <= value <= ceiling else None


def parse_options(raw: Any) -> WaveOptions | None:
    """Options from a client or a saved run, checked: bounded numbers, closed
    lists, booleans; None when anything is off."""
    if raw is None:
        return WaveOptions()
    if not isinstance(raw, dict):
        return None
    tolerance = _number(raw.get("tolerance"), 0, MAX_TOLERANCE)
    drift = _number(raw.get("driftThreshold"), 3, MAX_DRIFT_THRESHOLD)
    policy = raw.get("unplannedPolicy", "isolate")
    fragile = raw.get("fragileZones", True)
    code = raw.get("codeLinks", True)
    parallel = raw.get("maxParallel", DEFAULT_MAX_PARALLEL)
    if (
        tolerance is None
        or drift is None
        or policy not in POLICIES
        or not isinstance(fragile, bool)
        or not isinstance(code, bool)
        or isinstance(parallel, bool)
        or not isinstance(parallel, int)
        or not 1 <= parallel <= MAX_PARALLEL_CEILING
    ):
        return None
    return WaveOptions(tolerance, policy, drift, fragile, code, parallel)


@dataclass
class Card:
    """A card of the clone as the plan reads it."""

    id: str
    title: str
    column: str
    archived: bool
    abandoned: bool
    priority_weight: int
    created_at_ms: int
    blocked_by: list[str]
    planned_files: list[str]
    base_branch: str
    has_spec: bool


def read_json(path: Path) -> dict[str, Any]:
    """A JSON object from a regular file (not a link) under its size; {} otherwise."""
    # Windows has no O_NOFOLLOW: the link is refused on lstat, and the file
    # opened must be the one checked, so a link swapped in between is not read.
    try:
        before = os.lstat(path)
        if stat.S_ISLNK(before.st_mode):
            return {}
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return {}
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_ino, opened.st_dev) != (
            before.st_ino,
            before.st_dev,
        ):
            return {}
        raw = os.read(fd, MAX_JSON_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_JSON_BYTES:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _strings(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def subtask_files(subtask: dict[str, Any]) -> list[str]:
    """The real ``files_changed`` once there, else what the planner predicted."""
    actual = _strings(subtask.get("files_changed"))
    if actual:
        return list(dict.fromkeys(actual))
    predicted = [
        *_strings(subtask.get("files_to_modify")),
        *_strings(subtask.get("files_to_create")),
        *_strings(subtask.get("files")),
    ]
    return list(dict.fromkeys(predicted))


def plan_files(plan: dict[str, Any]) -> list[str]:
    files: list[str] = []
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks") or []:
            if isinstance(subtask, dict):
                files.extend(subtask_files(subtask))
    return files


def _ms(value: Any) -> int:
    if not isinstance(value, str):
        return 0
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp() * 1000)


def read_cards(clone: Path, default_branch: str | None) -> list[Card]:
    """Every card of the clone, newest first."""
    from board_mcp.server import CARD_ID, COLUMNS, SPECS
    from shared_board.listing import card_source

    root = clone.resolve()
    specs = root / SPECS
    if not specs.is_dir():
        return []
    cards: list[Card] = []
    for entry in sorted(specs.iterdir(), reverse=True):
        if not (
            CARD_ID.match(entry.name)
            and entry.is_dir()
            and entry.resolve().is_relative_to(root)
        ):
            continue
        source = card_source(root, entry)
        plan = read_json(source / "implementation_plan.json")
        meta = read_json(entry / "task_metadata.json")
        requirements = read_json(source / "requirements.json")
        title = (
            plan.get("feature")
            or plan.get("title")
            or requirements.get("task_description")
            or entry.name
        )
        base = meta.get("baseBranch")
        if not (isinstance(base, str) and git_reads.BRANCH.match(base)):
            base = default_branch or "main"
        cards.append(
            Card(
                id=entry.name,
                title=" ".join(str(title).split())[:MAX_TITLE],
                column=COLUMNS.get(str(plan.get("status") or ""), "backlog"),
                archived=bool(meta.get("archivedAt")),
                abandoned=bool(meta.get("abandoned")),
                priority_weight=PRIORITY_WEIGHT.get(str(meta.get("priority")), 0),
                created_at_ms=_ms(plan.get("created_at")),
                blocked_by=[
                    b for b in _strings(meta.get("blockedBy")) if CARD_ID.match(b)
                ],
                planned_files=plan_files(plan),
                base_branch=base,
                has_spec=(source / "spec.md").is_file(),
            )
        )
    return cards


def build_plan(
    clone: Path,
    default_branch: str | None,
    options: WaveOptions,
    only: list[str] | None = None,
) -> dict[str, Any]:
    """The plan of the clone's backlog (or of ``only``, cards not started yet)."""
    root = clone.resolve()
    cards = [c for c in read_cards(root, default_branch) if not c.archived]
    candidates = [c for c in cards if c.column in PLANNABLE]
    if only is not None:
        wanted = set(only)
        candidates = [c for c in candidates if c.id in wanted]
    candidates = candidates[:MAX_PLAN_TASKS]
    running = [c for c in cards if c.column in RUNNING]

    def to_planner(card: Card) -> PlannerTask:
        return PlannerTask(
            id=card.id,
            title=card.title,
            status=card.column,
            priority_weight=card.priority_weight,
            created_at_ms=card.created_at_ms,
            blocked_by=card.blocked_by,
            planned_files=card.planned_files,
            actual_files=git_reads.changed_files(root, card.id, card.base_branch),
        )

    base_of = {c.id: c.base_branch for c in [*candidates, *running]}
    planned_candidates = [to_planner(c) for c in candidates]
    planned_running = [to_planner(c) for c in running]
    co_changes = git_reads.read_co_changes(root) if options.fragile_zones else None
    budget = git_reads.CodeBudget()
    if options.code_links:
        for task in [*planned_candidates, *planned_running]:
            footprint = build_footprint(task.planned_files, task.actual_files or [])
            if footprint:
                task.code = git_reads.read_spec_code(
                    root, task.id, base_of[task.id], footprint, budget
                )

    def plan(checks: dict[str, MergeOutcome]) -> dict[str, Any]:
        return plan_execution_waves(
            planned_candidates,
            planned_running,
            PlannerOptions(
                max_parallel=options.max_parallel,
                tolerance=options.tolerance,
                unplanned_policy=options.unplanned_policy,
                drift_threshold=options.drift_threshold,
                merge_checks=checks,
                co_changes=co_changes[0] if co_changes else None,
            ),
        )

    with_workspace = {t.id for t in planned_candidates if t.actual_files is not None}
    result, merge_checks = plan_with_merge_checks(
        plan,
        with_workspace,
        lambda card: git_reads.workspace_head(root, card),
        lambda a, b, timeout: git_reads.trial_merge(root, a, b, timeout),
    )
    return {
        "maxParallel": options.max_parallel,
        "tolerance": options.tolerance,
        "unplannedPolicy": options.unplanned_policy,
        **result,
        "mergeChecks": merge_checks,
        "fragileZones": {
            "enabled": options.fragile_zones,
            "commits": co_changes[1] if co_changes else None,
        },
        "codeLinks": {
            "enabled": options.code_links,
            "files": budget.read,
            "capped": budget.capped,
        },
        "computedAt": datetime.now(UTC).isoformat(),
    }


def avoided_by(plan: dict[str, Any]) -> dict[str, int]:
    """What a plan avoids: pairs of planned cards split, and the risk taken out."""
    planned = set(plan["order"])
    conflicts = sum(
        1
        for p in plan["pairs"]
        if p["blocking"]
        and not p["unknown"]
        and p["a"] in planned
        and p["b"] in planned
    )
    return {
        "conflicts": conflicts,
        "risk": max(0, int(plan["totalRisk"]) - int(plan["residualRisk"])),
    }
