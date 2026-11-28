"""The swarm as the coding phase of a build, when the person turned it on.

The coder loop calls :func:`run_swarm_phase` once the plan exists. With
``WORKPILOT_SWARM_MAX_PARALLEL`` set to 2 or more (the app's swarm setting),
the subtasks the plan lets run side by side are built in parallel, each in its
own worktree (``orchestrator``, ``subtask_worktree``), and merged into the
task's branch wave after wave. The loop then goes on as usual: whatever the
swarm did not finish (a failure, a merge that conflicted) is done by the
task's own coder, and QA runs on the whole.

Nothing happens when the swarm is off, in a swarm worker, when no two
subtasks can run together, outside a git checkout, or when the task's
worktree holds work that is not committed (the subtasks start from the
branch, and would not see it).

When the swarm stops because the task was paused or its policy said stop
(``halt``), the build stops at that pause (``BuildPaused``): the coder must
not start a session of its own right after it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from core.progress import is_build_complete, swarm_focus
from foundation.build_signals import BuildPaused

from . import subtask_worktree
from .dependency_analyzer import DependencyAnalyzer
from .types import SwarmConfig, SwarmPhase

#: The app's swarm setting: how many subtasks may run at once (off below 2).
SWARM_ENV = "WORKPILOT_SWARM_MAX_PARALLEL"
#: How many times a failed subtask is run again, and whether one failed wave
#: stops the swarm (the rest is then left to the task's own coder).
RETRIES_ENV = "WORKPILOT_SWARM_MAX_RETRIES"
FAIL_FAST_ENV = "WORKPILOT_SWARM_FAIL_FAST"

_ran: set[Path] = set()


def swarm_parallelism() -> int:
    """The number of subtasks the person lets run at once; 0 when off."""
    try:
        value = int(os.environ.get(SWARM_ENV, "0"))
    except ValueError:
        return 0
    return value if value >= 2 else 0


def swarm_config(parallel: int) -> SwarmConfig:
    """The swarm's configuration from the app's setting, defaults otherwise."""
    config = SwarmConfig(max_parallel_agents=parallel)
    try:
        retries = int(os.environ.get(RETRIES_ENV, ""))
    except ValueError:
        retries = -1
    if 0 <= retries <= 5:
        config.max_retries_per_subtask = retries
    config.fail_fast = os.environ.get(FAIL_FAST_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    return config


def _skip_reason(project_dir: Path, spec_dir: Path, parallel: int) -> str | None:
    try:
        plan = json.loads(
            (spec_dir / subtask_worktree.PLAN_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return "the plan cannot be read"
    waves, _nodes = DependencyAnalyzer(max_parallel=parallel).analyze(plan)
    if not any(len(wave.subtask_ids) > 1 for wave in waves):
        return "no two subtasks of the plan can run side by side"
    if not subtask_worktree.is_checkout(project_dir):
        return "the task is not in a git checkout"
    if not subtask_worktree.is_clean(project_dir):
        return "the task's worktree holds uncommitted work"
    return None


async def run_swarm_phase(
    project_dir: Path, spec_dir: Path, source_spec_dir: Path | None = None
) -> bool:
    """Build what the plan lets run in parallel; whether the build is complete.

    Runs once per task and process; every later call returns False.
    """
    key = Path(spec_dir).resolve()
    parallel = swarm_parallelism()
    if key in _ran or not parallel or swarm_focus():
        return False
    _ran.add(key)

    reason = _skip_reason(project_dir, spec_dir, parallel)
    if reason:
        print(f"Swarm not used: {reason}. The subtasks run one after the other.")
        return False

    from agents.utils import sync_spec_to_source

    from .orchestrator import SwarmOrchestrator

    status = await SwarmOrchestrator(
        project_dir, spec_dir, swarm_config(parallel)
    ).run()
    print(
        f"Swarm: {status.completed_subtasks}/{status.total_subtasks} subtasks "
        "built in parallel" + (f" ({status.error})" if status.error else "")
    )
    if source_spec_dir:
        sync_spec_to_source(spec_dir, source_spec_dir)
    if status.phase == SwarmPhase.PAUSED:
        raise BuildPaused("coding")
    return is_build_complete(spec_dir)
