"""Where the full review's long suites run (``test_placement``), for the reviewer.

Only a full review runs the whole suite: a light or targeted one names its few
tests and stays here. The task's PR is read from ``task_metadata.json``
(``prUrl``, written by the app). A pause asked while the suite waits its turn
stops the build like any other QA pause. A machine that cannot be measured
never holds QA back: the review then runs here, as it always did.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import psutil
from foundation.build_signals import BuildPaused
from foundation.change_scope import ChangeScope
from foundation.pause_state import is_paused, read_pause_state
from tasks.metadata import read_task_metadata
from test_placement.decide import Decision
from test_placement.prepare import Placement, prepare
from test_placement.settings import MODES, TASK_ENV

__all__ = ["place_full_suite"]

logger = logging.getLogger(__name__)


def _has_pr(metadata: dict) -> bool:
    return bool(str(metadata.get("prUrl") or "").strip())


def _environment(metadata: dict) -> dict[str, str] | None:
    """The environment with the card's own choice, or ``None`` (the process's)."""
    choice = str(metadata.get("testPlacement") or "").strip().lower()
    if choice not in MODES:
        return None
    return {**os.environ, TASK_ENV: choice}


def _pause_check(spec_dir: Path):
    def check() -> None:
        if is_paused(spec_dir):
            state = read_pause_state(spec_dir)
            raise BuildPaused(
                state.get("paused_phase") or "qa_review",
                state.get("paused_subtask_id"),
            )

    return check


def _announce_wait(decision: Decision) -> None:
    short = ", ".join(decision.short) or "room"
    print(
        f"⏳ Full suite queued on this machine (short of {short}); "
        "it starts when there is room or when its turn comes."
    )


async def place_full_suite(
    project_dir: Path, spec_dir: Path, review_scope: ChangeScope | None
) -> Placement | None:
    """The placement of this review's full suite, or ``None`` (runs here)."""
    if review_scope is not None and not review_scope.is_full:
        return None
    metadata = read_task_metadata(spec_dir)
    try:
        placement = await prepare(
            project_dir,
            spec_dir,
            has_pr=_has_pr(metadata),
            env=_environment(metadata),
            check_pause=_pause_check(spec_dir),
            on_wait=_announce_wait,
        )
    except (OSError, ValueError, psutil.Error) as exc:
        logger.warning("test placement not decided (%s): the suite runs here", exc)
        return None
    if not placement.runs_here:
        print(f"☁️  Long suites of this task run on: {placement.decision.target}")
    return placement
