"""``--subtask <id>``: build one subtask of the plan, as a swarm wave does.

The swarm (``agents/swarm``) gives each subtask of a wave its own worktree,
with a copy of the task's spec, and runs ``run.py --subtask`` there. This is
that worker: the task's coder loop, kept on the one subtask, without the
build's preparation, gates or QA, which the task's own build runs once on the
merged result. It succeeds when the subtask is completed in its plan.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from core.progress import SWARM_SUBTASK_ENV, is_build_complete
from foundation.build_signals import BuildHalted


def handle_subtask_command(
    project_dir: Path,
    spec_dir: Path,
    model: str | None,
    subtask_id: str,
    verbose: bool = False,
) -> bool:
    """Run the coder on ``subtask_id`` alone; whether it got completed."""
    from core.agent import run_autonomous_agent
    from phase_config import get_phase_model

    if not (spec_dir / "implementation_plan.json").is_file():
        print(f"No plan to take subtask {subtask_id} from", file=sys.stderr)
        return False

    # Read by core.progress: the next subtask is this one, and the build is
    # complete when it is.
    os.environ[SWARM_SUBTASK_ENV] = subtask_id
    try:
        asyncio.run(
            run_autonomous_agent(
                project_dir=project_dir,
                spec_dir=spec_dir,
                model=get_phase_model(spec_dir, "coding", model),
                verbose=verbose,
            )
        )
    except BuildHalted as halted:
        print(f"Subtask {subtask_id} stopped: {halted}", file=sys.stderr)
        return False
    if not is_build_complete(spec_dir):
        print(f"Subtask {subtask_id} was not completed", file=sys.stderr)
        return False
    return True
