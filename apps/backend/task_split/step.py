"""The build's split step: a plan too big for one small PR becomes several cards.

Run once the plan exists and before the first line of code: by the build
before it opens a workspace (the spec pipeline already wrote the plan), and by
the coder right after its planner session (the plan was written in the
build). The cut itself is ``task_split``; this step tells the person and the
board, through the ``TASK_SPLIT`` task event the desktop settles the card on.
The caller hands the emitter class in (``core.task_event.TaskEventEmitter``):
this package sits below the agent runtime and imports nothing of it.

A split that cannot be written is never a failed build: the card is built
whole, as before, and the log says why.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol

from foundation.build_signals import BuildSplit
from ui import print_status

from .children import SplitError, split_spec

logger = logging.getLogger(__name__)

__all__ = ["raise_if_split", "split_before_build"]


class Emitter(Protocol):
    """What ``core.task_event.TaskEventEmitter`` offers this step."""

    @classmethod
    def from_spec_dir(cls, spec_dir: Path) -> Any: ...


def split_before_build(
    spec_dir: Path, emitter: type[Emitter], plan_dir: Path | None = None
) -> list[str]:
    """The cards the task became, or ``[]`` when it is built whole."""
    try:
        result = split_spec(spec_dir, plan_dir=plan_dir)
    except SplitError as exc:
        print_status(f"Task kept whole: {exc}", "warning")
        return []
    except Exception as exc:  # noqa: BLE001 - a split never fails a build
        logger.warning("split step failed, building the task whole: %s", exc)
        return []
    if result is None:
        return []
    print()
    print_status(
        f"The plan is larger than {result.max_lines} changed lines per pull "
        f"request: split into {len(result.children)} tasks",
        "success",
    )
    for child in result.children:
        after = f" (after {child.after})" if child.after else ""
        print(
            f"  {child.index}. {child.spec_id}: {child.name}, ~{child.lines} lines{after}"
        )
    print()
    emitter.from_spec_dir(spec_dir).emit("TASK_SPLIT", result.to_event())
    return [child.spec_id for child in result.children]


def raise_if_split(
    spec_dir: Path, emitter: type[Emitter], plan_dir: Path | None = None
) -> None:
    """Split the task when it is too big, and unwind the build if it was."""
    children = split_before_build(spec_dir, emitter, plan_dir)
    if children:
        raise BuildSplit(Path(spec_dir).name, children)
