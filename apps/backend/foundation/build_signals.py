"""Signals that unwind a build to its entry point.

A build is a stack: `handle_build_command` calls the coder loop, which calls a
session, which calls a phase. Two things can happen deep inside that stack that
are *not* the current step's business to resolve:

* the user pressed Pause — the build must stop where it is and stay resumable;
* a phase established that it cannot produce its output — the build must stop
  and say why.

Both used to be a bare `return`, which unwound exactly one frame: the coder loop
came back normally and `handle_build_command` went on to run QA, the hard gates
and `finalize_workspace` on a build that had no implementation plan at all. The
caller could not tell "finished" from "gave up" because the two looked identical.

Exceptions rather than a returned status because every intermediate frame would
otherwise have to know about, and forward, a value that is none of its concern.
"""

from __future__ import annotations


class BuildPaused(Exception):
    """The user paused the build; it stopped at a cooperative checkpoint.

    Not a failure: nothing is finalized, nothing is reported red, and the task
    keeps the kanban column it was in so `TASK_RESUME` can pick it back up.
    """

    def __init__(self, phase: str, subtask_id: str | None = None) -> None:
        self.phase = phase
        self.subtask_id = subtask_id
        detail = f" (subtask {subtask_id})" if subtask_id else ""
        super().__init__(f"Build paused during {phase}{detail}")


class BuildHalted(Exception):
    """A phase established it cannot produce its output.

    `message` is written for the person reading the kanban card, not for a log
    grep: it says what failed and what to change. It reaches the frontend as the
    `error` payload of the PLANNING_FAILED / CODING_FAILED task event, which is
    what puts a sentence on the card instead of a bare "Has Errors" badge.
    """

    def __init__(self, phase: str, message: str, *, recoverable: bool = True) -> None:
        self.phase = phase
        self.message = message
        self.recoverable = recoverable
        super().__init__(message)
