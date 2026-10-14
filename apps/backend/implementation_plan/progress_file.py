"""The header of ``build-progress.txt``, written from the plan.

The planner used to write this file itself: a multi-section narrative (phase
summary, services, parallelism, a startup command) that restated the plan in
output tokens. No code reads it; the QA reviewer and the follow-up planner
`cat` it. They get the same facts from a few lines rendered here, and later
sessions append one line per blocker.
"""

from __future__ import annotations

import json
from pathlib import Path

PROGRESS_FILE = "build-progress.txt"


def render_progress_header(plan: dict) -> str:
    """A short, deterministic header for the plan. Pure."""
    phases = [p for p in plan.get("phases") or [] if isinstance(p, dict)]
    subtasks = sum(len(p.get("subtasks") or []) for p in phases)
    lines = [
        f"# Build progress — {plan.get('feature') or 'task'}",
        f"Workflow: {plan.get('workflow_type') or 'feature'} · "
        f"{len(phases)} phases · {subtasks} subtasks",
    ]
    for phase in phases:
        deps = ", ".join(phase.get("depends_on") or []) or "none"
        lines.append(
            f"- {phase.get('id') or phase.get('phase')}: {phase.get('name', '')} "
            f"({len(phase.get('subtasks') or [])} subtasks, depends on {deps})"
        )
    lines += ["", "## Blockers (one line each: [subtask-id] blocker: ...)", ""]
    return "\n".join(lines)


def write_progress_header(spec_dir: Path) -> bool:
    """Create ``build-progress.txt`` from the plan unless it already exists.

    An existing file is kept: it may carry blockers from earlier sessions.
    Never raises.
    """
    target = Path(spec_dir) / PROGRESS_FILE
    if target.exists():
        return False
    try:
        plan = json.loads(
            (Path(spec_dir) / "implementation_plan.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return False
    if not isinstance(plan, dict):
        return False
    try:
        target.write_text(render_progress_header(plan), encoding="utf-8")
    except OSError:
        return False
    return True
