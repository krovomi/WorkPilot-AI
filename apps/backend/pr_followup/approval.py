"""The approval tier of a task's green pull request, and the merge it allows.

When the follow-through finds the PR green (every check passed, no review
thread waiting), it asks the approvals engine (``apps/backend/approvals``)
what that PR's tier lets happen. The facts are the ones the task produced:

- the change set from the base branch to the head the forge judged;
- the PR title and labels, the card's kind (``task_metadata.json``);
- the cross-review verdict, only when it was given on this very tree (a
  verdict about an older tree, before a fix round, says nothing of this one);
- the lowest trust score of the task's agent sessions (``agent_safety.json``).

The decision is kept in ``approval_decision.json`` and summarised as
``approval`` in ``implementation_plan.json`` for the card's badge. The PR is
merged only when ``Decision.merges`` is true: enforce mode, action ``merge``.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

from .claude_ship import ShipFacts, hold, read_checks
from .model import PRSnapshot

logger = logging.getLogger(__name__)

DECISION_FILE = "approval_decision.json"
SAFETY_FILE = "agent_safety.json"
_PLAN = "implementation_plan.json"
_REVIEW_FILE = "cross_review.json"
_MAX_REASONS = 8
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")

Merger = Callable[[str], Awaitable[tuple[bool, str]]]
"""(head_sha) -> (merged, error): merge the PR at exactly this head."""
CheckRuns = Callable[[str], Awaitable[list[Any] | None]]
"""(head_sha) -> the head's check runs as the forge serves them, None if unreadable."""


def review_state(spec_dir: Path, worktree: Path, head_sha: str) -> str:
    """The cross-review verdict on the PR's head tree, else ``none``."""
    from cross_review.review import read_verdict, tree_fingerprint

    record = read_verdict(spec_dir)
    if record is None or not record.get("tree"):
        return "none"
    head = run_git(["rev-parse", "HEAD"], cwd=worktree)
    if head.returncode != 0 or head.stdout.strip() != head_sha:
        return "none"
    if tree_fingerprint(worktree) != record["tree"]:
        return "none"
    return str(record["verdict"])


def trust_score(spec_dir: Path) -> int | None:
    """The lowest trust score of the task's sessions, None when none was measured."""
    try:
        data = json.loads((spec_dir / SAFETY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    sessions = data.get("sessions") if isinstance(data, dict) else None
    scores = [
        s["trustScore"]
        for s in sessions or []
        if isinstance(s, dict)
        and isinstance(s.get("trustScore"), int | float)
        and not isinstance(s.get("trustScore"), bool)
    ]
    return int(min(scores)) if scores else None


def judge(
    project_dir: Path,
    worktree: Path,
    spec_dir: Path,
    snap: PRSnapshot,
    ship: ShipFacts | None = None,
) -> dict[str, Any]:
    """The decision for a green PR, as ``Decision.to_dict()``, or an ``error``.

    ``ship``: what Claude Ship said on the head (``claude_ship.read_checks``),
    when the app turned the adapter on. Its Code Review stands in for a
    cross-review that did not see this tree; its Approvals can only hold.
    """
    from approvals import (
        build_facts,
        changed_files,
        clean_layers_touched,
        decide,
        load_approval_policy,
    )
    from security.guardrail_policy import main_project
    from tasks.metadata import read_task_metadata

    if not _branch_ok(snap.base_branch) or not snap.head_sha:
        return {"error": "the forge did not give a usable base branch and head"}
    fetch = [f"+refs/heads/{snap.base_branch}:refs/remotes/origin/{snap.base_branch}"]
    if _branch_ok(snap.head_branch):
        fetch.append(f"refs/heads/{snap.head_branch}")
    run_git(["fetch", "--no-tags", "origin", *fetch], cwd=worktree, timeout=120)
    files = changed_files(worktree, f"origin/{snap.base_branch}", snap.head_sha)
    if files is None:
        return {"error": "git could not list the change set of the pull request"}
    project = main_project(project_dir)
    kind = read_task_metadata(spec_dir).get("kind")
    review = review_state(spec_dir, worktree, snap.head_sha)
    if review == "none" and ship is not None and ship.code_review:
        review = ship.code_review
    facts = build_facts(
        files,
        title=snap.title,
        kind=kind if isinstance(kind, str) else None,
        base=snap.base_branch,
        labels=list(snap.labels),
        ci="green",
        review=review,
        trust=trust_score(spec_dir),
        layers=clean_layers_touched(project, [f.path for f in files]),
    )
    decision = decide(facts, load_approval_policy(project)).to_dict()
    return hold(decision, ship) if ship is not None else decision


def _branch_ok(name: str) -> bool:
    return bool(_BRANCH.match(name or "")) and ".." not in name


async def approve_green(
    project_dir: Path,
    worktree: Path,
    spec_dir: Path,
    snap: PRSnapshot,
    merge: Merger,
    check_runs: CheckRuns | None = None,
) -> dict[str, Any]:
    """Judge the green PR, merge it when the decision says so, keep the record.

    ``check_runs`` is given only when Claude Ship is on: its checks on the
    head are read as facts (``claude_ship.py``).
    """
    try:
        ship = read_checks(await check_runs(snap.head_sha)) if check_runs else None
        decision = judge(project_dir, worktree, spec_dir, snap, ship)
    except (OSError, ValueError) as exc:
        decision = {"error": str(exc)[:300]}
    merged, error = False, ""
    if decision.get("merges") is True:
        merged, error = await merge(snap.head_sha)
    record = {
        "version": 1,
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "head": snap.head_sha,
        "decision": decision,
        "merged": merged,
        "mergeError": error[:300],
    }
    _write(spec_dir, record)
    return record


def _write(spec_dir: Path, record: dict[str, Any]) -> None:
    path = spec_dir / DECISION_FILE
    try:
        if path.is_symlink():
            raise OSError(f"refusing to write through a symlink: {path}")
        partial = path.with_suffix(".json.partial")
        partial.write_text(
            json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError as exc:
        logger.warning("could not write the approval decision: %s", exc)
    _plan_summary(spec_dir, record)


def plan_summary(record: dict[str, Any]) -> dict[str, Any]:
    """What the card shows: tier, action, mode, merged, the strictest reasons."""
    decision = record.get("decision") or {}
    if decision.get("error"):
        return {"error": str(decision["error"])[:300], "at": record.get("at", "")}
    return {
        "tier": decision.get("tier", ""),
        "action": decision.get("action", ""),
        "mode": decision.get("mode", ""),
        "merged": bool(record.get("merged")),
        "mergeError": record.get("mergeError", ""),
        "reasons": [
            {"code": r.get("code", ""), "tier": r.get("tier", "")}
            for r in (decision.get("reasons") or [])[:_MAX_REASONS]
            if isinstance(r, dict)
        ],
        "at": record.get("at", ""),
    }


def _plan_summary(spec_dir: Path, record: dict[str, Any]) -> None:
    """``approval`` in the plan, merged into what it holds (like ``crossReview``)."""
    path = spec_dir / _PLAN
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(plan, dict) or path.is_symlink():
        return
    plan["approval"] = plan_summary(record)
    partial = path.with_suffix(".json.ap-partial")
    try:
        partial.write_text(
            json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError as exc:
        logger.debug("approval: could not update the plan summary: %s", exc)


__all__ = [
    "DECISION_FILE",
    "CheckRuns",
    "Merger",
    "approve_green",
    "judge",
    "plan_summary",
    "review_state",
    "trust_score",
]
