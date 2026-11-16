"""
Progress Tracking Utilities
===========================

Functions for tracking and displaying progress of the autonomous coding agent.
Uses subtask-based implementation plans (implementation_plan.json).

Enhanced with colored output, icons, and better visual formatting.
"""

import json
import logging
import os
from pathlib import Path

from core.plan_normalization import normalize_subtask_aliases

logger = logging.getLogger(__name__)
from datetime import UTC

from ui import (
    Icons,
    bold,
    box,
    highlight,
    icon,
    muted,
    print_phase_status,
    print_status,
    progress_bar,
    success,
    warning,
)


def _read_plan(spec_dir: Path) -> dict | None:
    """The spec's implementation_plan.json, or None if absent or unreadable."""
    try:
        with open(spec_dir / "implementation_plan.json", encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return plan if isinstance(plan, dict) else None


def _count_done(plan: dict) -> tuple[int, int]:
    """(done, total) subtasks of `plan`.

    "blocked" counts as done: a blocked subtask (an e2e test that needs a
    person, say) cannot be processed by the agent, so it must not keep the
    build from reaching QA / human_review.
    """
    statuses = [
        subtask.get("status")
        for phase in plan.get("phases", [])
        for subtask in phase.get("subtasks", [])
    ]
    return sum(s in ("completed", "blocked") for s in statuses), len(statuses)


def count_subtasks(spec_dir: Path) -> tuple[int, int]:
    """
    Count completed and total subtasks in implementation_plan.json.

    Args:
        spec_dir: Directory containing implementation_plan.json

    Returns:
        (completed_count, total_count)
    """
    plan = _read_plan(spec_dir)
    return _count_done(plan) if plan is not None else (0, 0)


def count_subtasks_detailed(spec_dir: Path) -> dict:
    """
    Count subtasks by status.

    Returns:
        Dict with completed, in_progress, pending, failed counts
    """
    plan_file = spec_dir / "implementation_plan.json"

    result = {
        "completed": 0,
        "in_progress": 0,
        "pending": 0,
        "failed": 0,
        "total": 0,
    }

    if not plan_file.exists():
        return result

    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)

        for phase in plan.get("phases", []):
            for subtask in phase.get("subtasks", []):
                result["total"] += 1
                status = subtask.get("status", "pending")
                if status in result:
                    result[status] += 1
                else:
                    result["pending"] += 1

        return result
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return result


def is_build_complete(spec_dir: Path) -> bool:
    """
    Check if all subtasks are completed.

    Args:
        spec_dir: Directory containing implementation_plan.json

    Returns:
        True if all subtasks complete, False otherwise
    """
    focus = swarm_focus()
    if focus:
        entry = _focused_subtask(spec_dir, focus)
        return entry is not None and entry.get("status") == "completed"
    completed, total = count_subtasks(spec_dir)
    return total > 0 and completed == total


#: Set for a swarm worker (``run.py --subtask``): the one subtask it builds.
SWARM_SUBTASK_ENV = "SWARM_SUBTASK_ID"


def swarm_focus() -> str | None:
    """The one subtask this process builds, when it is a swarm worker."""
    return os.environ.get(SWARM_SUBTASK_ENV) or None


def _focused_subtask(spec_dir: Path, subtask_id: str) -> dict | None:
    """``subtask_id``'s entry in the plan, with its phase, or None."""
    plan = _read_plan(spec_dir) or {}
    for phase in plan.get("phases", []):
        for subtask in phase.get("subtasks", phase.get("chunks", [])):
            if isinstance(subtask, dict) and subtask.get("id") == subtask_id:
                return {
                    **subtask,
                    "phase_id": phase.get("id", phase.get("phase")),
                    "phase_name": phase.get("name"),
                    "phase_num": phase.get("phase"),
                }
    return None


def get_progress_percentage(spec_dir: Path) -> float:
    """
    Get the progress as a percentage.

    Args:
        spec_dir: Directory containing implementation_plan.json

    Returns:
        Percentage of subtasks completed (0-100)
    """
    completed, total = count_subtasks(spec_dir)
    if total == 0:
        return 0.0
    return (completed / total) * 100


def print_session_header(
    session_num: int,
    is_planner: bool,
    subtask_id: str = None,
    subtask_desc: str = None,
    phase_name: str = None,
    attempt: int = 1,
) -> None:
    """Print a formatted header for the session."""
    session_type = "PLANNER AGENT" if is_planner else "CODING AGENT"
    session_icon = Icons.GEAR if is_planner else Icons.LIGHTNING

    content = [
        bold(f"{icon(session_icon)} SESSION {session_num}: {session_type}"),
    ]

    if subtask_id:
        content.append("")
        subtask_line = f"{icon(Icons.SUBTASK)} Subtask: {highlight(subtask_id)}"
        if subtask_desc:
            # Truncate long descriptions
            desc = subtask_desc[:50] + "..." if len(subtask_desc) > 50 else subtask_desc
            subtask_line += f" - {desc}"
        content.append(subtask_line)

    if phase_name:
        content.append(f"{icon(Icons.PHASE)} Phase: {phase_name}")

    if attempt > 1:
        content.append(warning(f"{icon(Icons.WARNING)} Attempt: {attempt}"))

    print()
    print(box(content, width=70, style="heavy"))
    print()


def print_progress_summary(spec_dir: Path, show_next: bool = True) -> None:
    """Print a summary of current progress with enhanced formatting."""
    plan = _read_plan(spec_dir)
    completed, total = _count_done(plan) if plan is not None else (0, 0)

    print()
    if total == 0:
        print_status("No implementation subtasks yet - planner needs to run", "pending")
        return

    print(f"Progress: {progress_bar(completed, total, width=40)}")
    if completed == total:
        print_status("BUILD COMPLETE - All subtasks completed!", "success")
    else:
        print_status(f"{total - completed} subtasks remaining", "info")

    print("\nPhases:")
    for phase in plan.get("phases", []):
        phase_subtasks = phase.get("subtasks", [])
        phase_completed = sum(
            1 for s in phase_subtasks if s.get("status") == "completed"
        )
        phase_total = len(phase_subtasks)
        phase_name = phase.get("name", phase.get("id", "Unknown"))

        if phase_completed == phase_total:
            status = "complete"
        elif phase_completed > 0 or any(
            s.get("status") == "in_progress" for s in phase_subtasks
        ):
            status = "in_progress"
        else:
            # Check if blocked by dependencies
            deps = phase.get("depends_on", [])
            all_deps_complete = True
            for dep_id in deps:
                for p in plan.get("phases", []):
                    if p.get("id") == dep_id or p.get("phase") == dep_id:
                        p_subtasks = p.get("subtasks", [])
                        if not all(s.get("status") == "completed" for s in p_subtasks):
                            all_deps_complete = False
                        break
            status = "pending" if all_deps_complete else "blocked"

        print_phase_status(phase_name, phase_completed, phase_total, status)

    # Show next subtask if requested
    if show_next and completed < total:
        next_subtask = get_next_subtask(spec_dir)
        if next_subtask:
            print()
            next_id = next_subtask.get("id", "unknown")
            next_desc = next_subtask.get("description", "")
            if len(next_desc) > 60:
                next_desc = next_desc[:57] + "..."
            print(
                f"  {icon(Icons.ARROW_RIGHT)} Next: {highlight(next_id)} - {next_desc}"
            )


def print_build_complete_banner(spec_dir: Path) -> None:
    """Print a completion banner."""
    content = [
        success(f"{icon(Icons.SUCCESS)} BUILD COMPLETE!"),
        "",
        "All subtasks have been implemented successfully.",
        "",
        muted("Next steps:"),
        f"  1. Review the {highlight('workpilot/*')} branch",
        "  2. Run manual tests",
        "  3. Create a PR and merge to main",
    ]

    print()
    print(box(content, width=70, style="heavy"))
    print()


def print_paused_banner(
    spec_dir: Path,
    spec_name: str,
    has_worktree: bool = False,
) -> None:
    """Print a paused banner with resume instructions."""
    completed, total = count_subtasks(spec_dir)

    content = [
        warning(f"{icon(Icons.PAUSE)} BUILD PAUSED"),
        "",
        f"Progress saved: {completed}/{total} subtasks complete",
    ]

    if has_worktree:
        content.append("")
        content.append(muted("Your build is in a separate workspace and is safe."))

    print()
    print(box(content, width=70, style="heavy"))


def get_current_phase(spec_dir: Path) -> dict | None:
    """Get the current phase being worked on."""
    plan_file = spec_dir / "implementation_plan.json"

    if not plan_file.exists():
        return None

    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)

        for phase in plan.get("phases", []):
            subtasks = phase.get("subtasks", phase.get("chunks", []))
            # Phase is current if it has incomplete subtasks and dependencies are met
            has_incomplete = any(s.get("status") != "completed" for s in subtasks)
            if has_incomplete:
                return {
                    "id": phase.get("id"),
                    "phase": phase.get("phase"),
                    "name": phase.get("name"),
                    "completed": sum(
                        1 for s in subtasks if s.get("status") == "completed"
                    ),
                    "total": len(subtasks),
                }

        return None

    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


_PENDING = frozenset({"pending", "not_started", "not started"})


def get_next_subtask(spec_dir: Path) -> dict | None:
    """
    Find the next subtask to work on, respecting phase dependencies.

    Args:
        spec_dir: Directory containing implementation_plan.json

    Returns:
        The next subtask dict to work on, or None if all complete
    """
    plan_file = spec_dir / "implementation_plan.json"

    if not plan_file.exists():
        return None

    focus = swarm_focus()
    if focus:
        # A swarm worker builds its one subtask: the swarm already ordered the
        # waves, and the subtasks of the other worktrees never complete here.
        entry = _focused_subtask(spec_dir, focus)
        if entry is None or entry.get("status", "pending") not in _PENDING:
            return None
        subtask_out, _changed = normalize_subtask_aliases(entry)
        return {**subtask_out, "status": "pending"}

    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)

        phases = plan.get("phases", [])

        # Build a map of phase completion
        phase_complete: dict[str, bool] = {}
        for i, phase in enumerate(phases):
            phase_id_value = phase.get("id")
            phase_id_raw = (
                phase_id_value if phase_id_value is not None else phase.get("phase")
            )
            phase_id_key = (
                str(phase_id_raw) if phase_id_raw is not None else f"unknown:{i}"
            )
            subtasks = phase.get("subtasks", phase.get("chunks", []))
            phase_complete[phase_id_key] = all(
                s.get("status") in ("completed", "blocked") for s in subtasks
            )

        # Find next available subtask
        for phase in phases:
            phase_id_value = phase.get("id")
            phase_id = (
                phase_id_value if phase_id_value is not None else phase.get("phase")
            )
            depends_on_raw = phase.get("depends_on", [])
            if isinstance(depends_on_raw, list):
                depends_on = [str(d) for d in depends_on_raw if d is not None]
            elif depends_on_raw is None:
                depends_on = []
            else:
                depends_on = [str(depends_on_raw)]

            # Check if dependencies are satisfied
            deps_satisfied = all(phase_complete.get(dep, False) for dep in depends_on)
            if not deps_satisfied:
                continue

            # Find first pending subtask in this phase
            for subtask in phase.get("subtasks", phase.get("chunks", [])):
                status = subtask.get("status", "pending")
                if status in _PENDING:
                    subtask_out, _changed = normalize_subtask_aliases(subtask)
                    subtask_out["status"] = "pending"
                    return {
                        **subtask_out,
                        "phase_id": phase_id,
                        "phase_name": phase.get("name"),
                        "phase_num": phase.get("phase"),
                    }

        return None

    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


#: Set on a subtask a previous process was in the middle of when it stopped.
#: Read by the coder to tell the next session that the work is half done, and
#: kept afterwards: a later retry of the same subtask starts from the same
#: half-finished working tree.
INTERRUPTED_AT_KEY = "interrupted_at"


def reopen_interrupted_subtasks(spec_dir: Path) -> list[str]:
    """Hand the subtasks a dead process left `in_progress` back to the loop.

    Called once, when a build process starts. The coder loop is sequential, so
    at that moment no session is running: a subtask still marked `in_progress`
    is one the previous process was working on when the application was
    closed, crashed or was paused. `get_next_subtask` only picks `pending`
    work, so without this the interrupted subtask was skipped for the next one
    — or, when it was the last, the build reported "no pending subtasks" and
    halted with the work unfinished. The only other way out, the Kanban's
    stuck-task recovery, reset it to `pending` and deleted what it had
    recorded, which is starting the subtask over.

    This keeps everything the subtask carried and marks it `interrupted_at`, so
    the next session is told to continue from the working tree rather than
    redo it. Returns the ids reopened; best-effort, an unreadable plan reopens
    nothing.
    """
    plan_file = spec_dir / "implementation_plan.json"
    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    if not isinstance(plan, dict):
        return []

    from datetime import datetime

    now = datetime.now(UTC).isoformat()
    reopened: list[str] = []
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks", phase.get("chunks", [])) or []:
            if isinstance(subtask, dict) and subtask.get("status") == "in_progress":
                subtask["status"] = "pending"
                subtask[INTERRUPTED_AT_KEY] = now
                reopened.append(str(subtask.get("id", "?")))

    if not reopened:
        return []
    try:
        from foundation.file_utils import write_json_atomic

        write_json_atomic(plan_file, plan)
    except OSError as e:
        logger.warning("Could not reopen interrupted subtasks in %s: %s", plan_file, e)
        return []
    return reopened


def interrupted_subtask_directive(subtask: dict) -> str:
    """The prompt paragraph for a subtask resumed after an interruption.

    Empty for a subtask that was never interrupted. The transcript of the
    interrupted session is replayed separately (conversation log, every
    provider); this says what the transcript cannot: that its end is not a
    conclusion, and that the files it wrote are already on disk.
    """
    if not subtask.get(INTERRUPTED_AT_KEY):
        return ""
    return (
        "## RESUMING AN INTERRUPTED SUBTASK\n\n"
        "A previous session was working on this subtask when the run was "
        "interrupted (the application was closed, crashed or was paused). "
        "Whatever it already changed is still in the working tree.\n\n"
        "1. Run `git status` and `git diff` first to see what is already done.\n"
        "2. Continue from there. Do not rewrite or revert work that is already "
        "correct, and do not start the subtask over.\n"
        "3. Finish the remaining steps, verify, commit, and mark the subtask "
        "completed as usual."
    )
