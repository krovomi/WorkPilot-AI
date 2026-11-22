"""The decision taken before a full QA review, and what follows from it.

``prepare`` reads the settings, the machine and the project's demand, decides,
and when the suite has nowhere to go waits in the machine's queue until there
is room or it is its turn (checking the task's pause on every round). The
decision is written to ``test_placement.json`` of the spec directory:

- the card shows its target and reason;
- the app reads it after the build to push the branch and follow the CI
  (``ci``) or hand the suite to the server (``server``).

``Placement.prompt_addendum`` is what the reviewer reads when its full suite
runs elsewhere; ``Placement.measure`` meters a session that runs here, and
``Placement.close`` records it in the project's history and frees the ticket.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field, replace
from pathlib import Path

from foundation.file_utils import write_json_atomic

from .decide import Decision, Demand, Machine, Routes, decide
from .demand import Meter, Usage, demand, record
from .queue import Ticket
from .settings import PlacementSettings, load_settings

__all__ = ["DECISION_FILE", "Placement", "prepare"]

logger = logging.getLogger(__name__)

DECISION_FILE = "test_placement.json"
POLL_SECONDS = 30.0

_ELSEWHERE = {
    "ci": "the CI of the project's forge (GitHub Actions, Azure Pipelines, "
    "GitLab CI, Bitbucket Pipelines or Jenkins, whichever the project uses)",
    "server": "the WorkPilot server the project is connected to",
}

_ADDENDUM = """## WHERE THE LONG SUITES RUN FOR THIS TASK

WorkPilot decided that this task's long suites run on {where}, not on this
machine ({why}).

- Do NOT run the whole test suite, the full build or the end-to-end suite in
  PHASE 7.1. They run there right after your sign-off, on the exact commit you
  approve; a red result comes back to the QA fixer with its errors.
- Still run, here, the tests of every file this task changed and the tests
  that import them, plus the unit tests of PHASE 3.1: a broken change must
  fail fast, before anything is pushed.
- In `qa_signoff.tests_passed`, write what you ran here and add
  `"full_suite": "deferred to {target}"`.
"""

_WHY = {
    "chosen": "the task's setting says so",
    "pr": "the machine is busy and the task's pull request exists",
    "server": "the machine is busy",
    "branch_push": "the machine is busy",
}


@dataclass
class Placement:
    decision: Decision
    settings: PlacementSettings
    project_dir: Path
    ticket: Ticket | None = None
    waited_seconds: float = 0.0
    _meter: Meter | None = field(default=None, repr=False)

    @property
    def runs_here(self) -> bool:
        return self.decision.runs_here

    def prompt_addendum(self) -> str:
        target = self.decision.target
        where = _ELSEWHERE.get(target)
        if not where:
            return ""
        why = _WHY.get(self.decision.reason, "the machine is busy")
        return _ADDENDUM.format(where=where, why=why, target=target)

    def measure(self) -> AbstractContextManager[object]:
        """Meter the session when it runs here; nothing otherwise."""
        if not self.runs_here:
            return nullcontext()
        self._meter = Meter()
        return self._meter

    def close(self) -> Usage | None:
        """Record what the session took and free the queue."""
        usage = self._meter.usage if self._meter is not None else None
        if usage is not None and usage.seconds > 0:
            record(self.project_dir, usage)
        if self.ticket is not None:
            self.ticket.release()
        return usage


def _write(spec_dir: Path, placement: Placement) -> None:
    payload = {
        **placement.decision.to_dict(),
        "decidedBy": placement.settings.decided_by,
        "waitedSeconds": round(placement.waited_seconds),
        "at": int(time.time()),
    }
    try:
        write_json_atomic(Path(spec_dir) / DECISION_FILE, payload)
    except OSError as exc:
        logger.warning("could not write %s: %s", DECISION_FILE, exc)


async def prepare(
    project_dir: Path,
    spec_dir: Path,
    *,
    has_pr: bool,
    server: bool = False,
    env: dict[str, str] | None = None,
    sampler: Callable[[int], Machine] | None = None,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
    check_pause: Callable[[], None] = lambda: None,
    on_wait: Callable[[Decision], None] = lambda _decision: None,
    ticket: Ticket | None = None,
    poll_seconds: float = POLL_SECONDS,
) -> Placement:
    """Decide where this task's full suite runs; wait in the queue if needed.

    ``check_pause`` raises the build's pause signal; the ticket is freed
    before it propagates.
    """
    if sampler is None:
        from .machine import sample as sampler  # psutil only when measuring

    settings = load_settings(project_dir, env)
    routes = Routes(
        ci="ci" in settings.routes,
        has_pr=has_pr,
        server=server and "server" in settings.routes,
        branch_push=settings.allow_branch_push,
    )
    need: Demand = demand(project_dir)
    ticket = ticket if ticket is not None else Ticket(label=Path(spec_dir).name)
    ticket.__enter__()
    started = time.monotonic()
    placed = False
    try:
        while True:
            if settings.mode == "machine":
                # The person chose this machine: nothing to measure.
                decision = Decision("machine", "chosen", "machine")
                break
            machine = await asyncio.to_thread(sampler, ticket.others_running())
            decision = decide(settings.mode, machine, need, routes)
            if decision.target != "queue":
                break
            if ticket.my_turn():
                decision = replace(decision, target="machine", reason="turn")
                break
            _write(
                spec_dir,
                Placement(
                    decision,
                    settings,
                    Path(project_dir),
                    None,
                    time.monotonic() - started,
                ),
            )
            on_wait(decision)
            check_pause()
            await sleep(poll_seconds)
        placed = True
    finally:
        # Paused, cancelled or failed while waiting: the ticket is freed
        # before the signal propagates.
        if not placed:
            ticket.release()

    placement = Placement(
        decision=decision,
        settings=settings,
        project_dir=Path(project_dir),
        ticket=ticket,
        waited_seconds=time.monotonic() - started,
    )
    if decision.runs_here:
        ticket.mark_running()
    else:
        ticket.release()
    _write(spec_dir, placement)
    return placement
