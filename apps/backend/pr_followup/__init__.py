"""PR follow-through: a task's card keeps driving its pull request to merge.

Once a task has opened its PR, the card used to stop at "PR created": a red
check or a review comment waited for a person. This package reads the PR's
state, decides what to do with it (`policy.decide`, pure), and when there is
something to fix runs the QA fixer in the task's worktree on the CI failure or
the review thread, then pushes. It never force-pushes, never merges, and a
fix that weakens a test is undone before anything leaves the machine
(`guards.py`).

See `docs/architecture/pr-followup.md` for the design.
"""

from .policy import Decision, DecisionKind, FollowupConfig, decide
from .state import FollowupState, load_state, save_state

__all__ = [
    "Decision",
    "DecisionKind",
    "FollowupConfig",
    "FollowupState",
    "decide",
    "load_state",
    "save_state",
]
