"""Split a task too big for one small pull request into several cards.

A card that changes 2 000 lines gives its reviewer one pull request of 2 000
lines. Once the plan is written, and before any code, WorkPilot measures it:
the lines each subtask expects to change (the planner's ``estimated_lines``,
or a count from the files it names) and the files it touches. Above the
project's ceiling (or the card's own), the plan is cut at phase boundaries
into slices that each fit, and every slice becomes a card of its own:

- ``policy``: the ceilings, from the card, the project settings, the defaults;
- ``slices``: the cut, pure (a plan in, slices out), the same for every
  provider and every stack because it reads only the plan's JSON;
- ``children``: the cards, on disk, so local and server mode see the same.

The parent card stays as the group's record, archived, and its children go to
the queue: a slice that depends on another is blocked by it (and stacked on
it when it starts, ``task-stack.ts``), an independent one starts at once.
"""

from __future__ import annotations

from .children import SplitError, SplitResult, child_spec_id, split_spec
from .policy import SplitPolicy, resolve_policy
from .slices import Slice, plan_slices

__all__ = [
    "Slice",
    "SplitError",
    "SplitPolicy",
    "SplitResult",
    "child_spec_id",
    "plan_slices",
    "resolve_policy",
    "split_spec",
]
