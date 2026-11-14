"""What the coder loop reads before each session, apart from the user's pause.

- The anti-burnout loop detector (opt-in, ``WORKPILOT_LOOP_DETECTION_ENABLED``):
  when iteration N produces the same diff as a recent earlier one, the coder is
  flip-flopping between two fixes; the build pauses for a person instead of
  burning more tokens.
- The cost budget (``cost_budget``, docs/architecture/cost-budgets.md): a task
  or project past its limit, or spending without completing subtasks, pauses
  before the next session.

Both raise ``BuildPaused``, which unwinds to ``handle_build_command`` like the
Pause button does.
"""

from __future__ import annotations

import logging
from pathlib import Path

from foundation.build_signals import BuildPaused
from ui import BuildState, StatusManager, print_status

from .agent_audit import audit_event
from .base import HUMAN_INTERVENTION_FILE

logger = logging.getLogger(__name__)


def _check_loop(
    spec_dir: Path,
    project_dir: Path,
    iteration: int,
    phase: str,
    status_manager: StatusManager,
) -> None:
    from agents.loop_detection import get_detector, loop_detection_enabled

    if not loop_detection_enabled() or iteration <= 1:
        return
    detector = get_detector(spec_dir)
    # hash_diff and record_and_check answer "" / False on a git failure.
    diff_hash = detector.hash_diff(project_dir)
    if not detector.record_and_check(diff_hash):
        return
    audit_event(
        project_dir,
        kind="policy_violated",
        actor="coder",
        correlation_id=spec_dir.name,
        summary=(
            f"Circular fix detected at iteration {iteration} — "
            "agent paused for human review"
        ),
        payload={
            "iteration": iteration,
            "diff_hash_prefix": diff_hash[:16],
            "buffer": detector.buffer_snapshot(),
        },
    )
    print_status("Circular fix detected — pausing for human intervention", "warning")
    try:
        (spec_dir / HUMAN_INTERVENTION_FILE).write_text(
            f"Loop detector triggered at iteration {iteration}.\n"
            f"The coder produced the same diff it had a few "
            f"iterations ago — likely a flip-flop between two "
            f"fixes. Inspect the diff and decide whether to:\n"
            f"  - delete this PAUSE file to resume,\n"
            f"  - or restart with a different approach.\n",
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning("Loop detector: PAUSE file not written: %s", exc)
    status_manager.update(state=BuildState.PAUSED)
    raise BuildPaused(phase)


def _check_budget(spec_dir: Path, phase: str, status_manager: StatusManager) -> None:
    from cost_budget import check_before_session

    if check_before_session(spec_dir, phase) is not None:
        status_manager.update(state=BuildState.PAUSED)
        raise BuildPaused(phase)


def guard_iteration(
    spec_dir: Path,
    project_dir: Path,
    iteration: int,
    is_planning: bool,
    status_manager: StatusManager,
) -> None:
    phase = "planning" if is_planning else "coding"
    _check_loop(spec_dir, project_dir, iteration, phase, status_manager)
    _check_budget(spec_dir, phase, status_manager)


__all__ = ["guard_iteration"]
