"""Preventive merge check around the planner: two cards of one wave, both
with a build workspace, sharing files under the tolerance, are test-merged
(``git merge-tree``, object store only). A conflict adds an edge and the plan
is computed again, until no such pair is left or a limit is reached: at most
``MAX_MERGE_CHECKS`` pairs and ``MERGE_CHECK_BUDGET_S`` per plan, each call
under its own timeout. Same rules as the desktop (``merge-check.ts``).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from .planner import MergeOutcome, pair_key

MAX_MERGE_CHECKS = 24
MERGE_CHECK_BUDGET_S = 20.0
MERGE_CHECK_TIMEOUT_S = 8.0

Plan = Callable[[dict[str, MergeOutcome]], dict[str, Any]]
Head = Callable[[str], str | None]
TestMerge = Callable[[str, str, float], MergeOutcome | None]


def _pending(
    result: dict[str, Any], with_workspace: set[str], attempted: set[str]
) -> list[tuple[str, str, str]]:
    wave_of = {i: w["index"] for w in result["waves"] for i in w["taskIds"]}
    pending = []
    for p in result["pairs"]:
        key = pair_key(p["a"], p["b"])
        if (
            not p["blocking"]
            and p["score"] > 0
            and p["a"] in with_workspace
            and p["b"] in with_workspace
            and wave_of.get(p["a"]) == wave_of.get(p["b"])
            and key not in attempted
        ):
            pending.append((p["a"], p["b"], key))
    return pending


def plan_with_merge_checks(
    plan: Plan,
    with_workspace: set[str],
    head_of: Head,
    merge: TestMerge,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, Any], dict[str, int]]:
    deadline = clock() + MERGE_CHECK_BUDGET_S
    checks: dict[str, MergeOutcome] = {}
    attempted: set[str] = set()
    heads: dict[str, str | None] = {}

    def head(card: str) -> str | None:
        if card not in heads:
            heads[card] = head_of(card)
        return heads[card]

    failed = 0
    result = plan(checks)
    planned_with = 0
    split = True
    while split:
        split = False
        for a, b, key in _pending(result, with_workspace, attempted):
            remaining = deadline - clock()
            if len(attempted) >= MAX_MERGE_CHECKS or remaining <= 0:
                break
            attempted.add(key)
            head_a, head_b = head(a), head(b)
            outcome = (
                merge(head_a, head_b, min(MERGE_CHECK_TIMEOUT_S, remaining))
                if head_a and head_b
                else None
            )
            if outcome is None:
                failed += 1
                continue
            checks[key] = outcome
            if outcome.verdict == "conflict":
                split = True
                break
        if split:
            result = plan(checks)
            planned_with = len(checks)
    # Clean verdicts add no edge: the waves stay, the pairs show the verdict.
    if len(checks) != planned_with:
        result = plan(checks)
    conflicts = sum(1 for c in checks.values() if c.verdict == "conflict")
    return result, {
        "checked": len(checks),
        "conflicts": conflicts,
        "unchecked": len(_pending(result, with_workspace, attempted)),
        "failed": failed,
    }
