"""The hermes learning cycle, opened by the GitHub workflows.

`hermes.loop.SURFACES` has listed ``github`` since the cycle was written, and
nothing opened it: a pull request review or an issue triage finished, and the
skills hermes had authored meanwhile waited for the next build to be noticed.
This is the one call those workflows make, so they all turn the cycle the same
way — and so the orchestrator, which already sits close to its size ceiling,
gains a line per workflow rather than a policy.

What it does not do is change a result. The review was decided, saved and
possibly posted before this runs; whatever hermes filed lands in
``skills/_proposed/`` and waits for a person, like every other surface.

Desktop only, for the reason `hermes/api.py` gives: on a shared server
``$HERMES_HOME`` belongs to the server process, not to the tenant whose pull
request was reviewed, and its candidates would land in a queue that is not
theirs. There is no per-tenant hermes to address, so the server skips the turn.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["SURFACE", "observe_with_hermes"]

SURFACE = "github"


def _server_mode() -> bool:
    from foundation.api_safety import server_mode_roots

    return server_mode_roots() is not None


async def observe_with_hermes(project_dir: Path):
    """Turn the hermes cycle for a finished GitHub workflow.

    Returns the `hermes.loop.CycleReport`, or None when the turn was skipped
    (hermes code unavailable, or server mode). Never raises: `run_cycle` already
    swallows a broken ingest, and the only failure left is the optional package
    being absent from this build.
    """
    try:
        from hermes.loop import run_cycle

        if _server_mode():
            return None
    except ImportError as exc:
        logger.debug("hermes cycle unavailable: %s", exc)
        return None

    # Off the event loop: the cycle reads $HERMES_HOME and writes the review
    # queue, and a review runner shares its loop with progress reporting.
    result = await asyncio.to_thread(run_cycle, Path(project_dir), surface=SURFACE)
    if result.proposed:
        logger.info(
            "hermes: %d candidate(s) filed in skills/_proposed/ for review",
            result.proposed,
        )
    return result
