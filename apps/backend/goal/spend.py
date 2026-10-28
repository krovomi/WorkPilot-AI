"""What the task has spent so far, read from the usage ledger.

``core.usage_tracker`` appends every session's cost to
``<project>/.workpilot/cost_data.json``, the project being the one above the
spec directory the session ran with. A build in a worktree writes to the
worktree's ledger and a planning run to the main project's, so both are read
and added.

A provider with no known price records a cost of 0 beside real tokens. The
total is then a floor, and says so (``complete=False``): the cap still stops
the loop when the floor reaches it, and the card says the figure is partial.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

__all__ = ["TaskSpend", "task_spend"]


@dataclass(frozen=True)
class TaskSpend:
    usd: float
    complete: bool
    """False when some session used tokens with no price to count them."""


def _ledger(spec_dir: Path) -> Path:
    return spec_dir.parent.parent.parent / ".workpilot" / "cost_data.json"


def task_spend(*spec_dirs: Path | None) -> TaskSpend:
    spec_id = next((Path(d).name for d in spec_dirs if d is not None), "")
    seen: set[Path] = set()
    total = 0.0
    complete = True
    for spec_dir in spec_dirs:
        if spec_dir is None:
            continue
        path = _ledger(Path(spec_dir))
        try:
            key = path.resolve()
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        usages = data.get("usages") if isinstance(data, dict) else None
        for usage in usages if isinstance(usages, list) else []:
            if not isinstance(usage, dict) or usage.get("spec_id") != spec_id:
                continue
            cost = usage.get("cost")
            tokens = (usage.get("input_tokens") or 0) + (
                usage.get("output_tokens") or 0
            )
            if (
                isinstance(cost, int | float)
                and not isinstance(cost, bool)
                and cost > 0
            ):
                total += float(cost)
            elif tokens:
                complete = False
    return TaskSpend(round(total, 4), complete)
