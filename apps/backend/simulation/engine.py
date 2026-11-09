"""The plan-rehearsal report shown on the sandbox page.

``rehearse_spec`` reads the spec's ``implementation_plan.json``, snapshots the
base ref, walks the plan and returns a ``SimulationResult`` (the shape of
``shared/types/sandbox.ts``) with ``mode = "plan"``. The predicted footprint
replaces the git diff of the other mode: one entry per file the plan creates
or modifies, without hunks, since no code has been written yet.
"""

from __future__ import annotations

import json
import subprocess
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import api_mocks
from .plan_rehearsal import ERROR, INFO, WARNING, Finding, rehearse
from .snapshot import read_snapshot

DEFAULT_TIMEOUT_S = 60


def _tracked_reader(project_path: Path, ref: str, tracked: set[str]):
    cache: dict[str, str | None] = {}

    def read(path: str) -> str | None:
        if path not in tracked:
            return None  # planned by the walk, not in the ref
        if path not in cache:
            try:
                result = subprocess.run(
                    ["git", "show", f"{ref}:{path}"],
                    cwd=str(project_path),
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                cache[path] = (
                    result.stdout.decode("utf-8", "replace")
                    if result.returncode == 0
                    else None
                )
            except (OSError, subprocess.TimeoutExpired):
                cache[path] = None
        return cache[path]

    return read


def _estimate(spec_dir: Path) -> dict[str, Any] | None:
    try:
        from cost_intelligence.estimator import estimate_build_cost
    except ImportError:  # the estimate is a bonus, never a blocker
        return None
    return estimate_build_cost(spec_dir).to_dict()  # never raises, by contract


def rehearse_spec(
    project_path: Path,
    spec_dir: Path,
    ref: str = "HEAD",
    timeout_s: float = DEFAULT_TIMEOUT_S,
    emit=None,
) -> dict[str, Any]:
    """Rehearse the plan of ``spec_dir`` over ``ref`` of ``project_path``."""
    started = time.monotonic()
    say = emit or (lambda _status: None)

    plan_findings: list[Finding] = []
    plan: dict[str, Any] = {}
    plan_path = spec_dir / "implementation_plan.json"
    try:
        loaded = json.loads(plan_path.read_text(encoding="utf-8"))
        plan = loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError) as exc:
        plan_findings.append(Finding(ERROR, "plan_unreadable", {"reason": str(exc)}))

    say(f"Reading the files of {ref}...")
    snapshot = read_snapshot(project_path, ref)
    tracked = set(snapshot.files)
    read_tracked = _tracked_reader(project_path, ref, tracked)

    say("Looking for API contracts...")
    contracts = api_mocks.build_index(tracked, read_tracked)

    say("Walking the plan subtask by subtask...")
    walk = rehearse(
        plan, snapshot, read_tracked, contracts, deadline=started + timeout_s
    )
    plan_findings.extend(walk.plan_findings)
    if walk.partial:
        plan_findings.append(Finding(WARNING, "timeout", {"seconds": int(timeout_s)}))

    diffs = [
        {
            "filePath": path,
            "changeType": "added",
            "additions": 0,
            "deletions": 0,
            "hunks": [],
            "subtaskId": owner,
        }
        for path, owner in sorted(walk.created.items())
    ] + [
        {
            "filePath": path,
            "changeType": "modified",
            "additions": 0,
            "deletions": 0,
            "hunks": [],
            "subtaskId": owner,
        }
        for path, owner in sorted(walk.modified.items())
        if path not in walk.created
    ]

    steps = [step.to_dict() for step in walk.steps]
    errors = sum(1 for s in walk.steps if s.status == "error") + sum(
        1 for f in plan_findings if f.level == ERROR
    )
    warnings = sum(1 for s in walk.steps if s.status == "warning") + sum(
        1 for f in plan_findings if f.level == WARNING
    )
    estimate = _estimate(spec_dir)
    return {
        "id": str(uuid.uuid4()),
        "specId": spec_dir.name,
        "mode": "plan",
        "baseRef": ref,
        "phase": "complete",
        "steps": steps,
        "diffs": diffs,
        "planFindings": [f.to_dict() for f in plan_findings],
        "contracts": contracts.contracts + contracts.other_schemas,
        "partial": walk.partial,
        "totalTokensUsed": 0,
        "estimatedCostUsd": 0.0,
        "estimatedRealCostUsd": float(estimate["total_cost_usd"]) if estimate else 0.0,
        "costEstimate": estimate,
        "durationMs": int((time.monotonic() - started) * 1000),
        "successCount": sum(1 for s in walk.steps if s.status == "success"),
        "warningCount": warnings,
        "errorCount": errors,
        "verdict": "blocked" if errors else "review" if warnings else "ready",
        "infoCount": sum(1 for s in walk.steps for f in s.findings if f.level == INFO),
        "createdAt": datetime.now(tz=UTC).isoformat(),
    }
