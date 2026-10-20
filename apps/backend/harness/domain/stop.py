"""When the WorkPilot loop stops, and why.

The loop stops on the first of three conditions, checked after every turn in
this order: the model is done (a reply with no tool call that the adapter
accepts as the end), it is repeating itself (``harness.domain.progress``), or
the turns are spent. The order matters on the last turn: a model that finishes
there has finished, it did not run out of turns. A turn that is retried (an
empty answer, a model pulled, a nudge) counts like any other.

The fourth condition, the spending cap, is checked by the session runner after
every message, around the loop (``harness.application.budget``). An error the
provider's protocol cannot recover from is not a decision: the adapter says
so and the response ends there.

Pure, table-tested in ``tests/harness/test_stop.py``.
"""

from __future__ import annotations

from typing import Literal

from .progress import Verdict

StopReason = Literal["natural_end", "no_progress", "max_turns"]


def stop_reason(
    *,
    turns: int,
    max_turns: int,
    done: bool = False,
    progress: Verdict = "continue",
) -> StopReason | None:
    """Why the loop stops after ``turns`` turns, or None to take another."""
    if done:
        return "natural_end"
    if progress == "stop":
        return "no_progress"
    if turns >= max_turns:
        return "max_turns"
    return None
