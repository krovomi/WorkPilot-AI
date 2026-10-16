"""What the engine knows about the task a workflow is resolved for.

Two facts, both already on disk before a workflow is read, both written by
the spec pipeline without this module's help: the card's **kind**
(`tasks.metadata`, lot 0) and its assessed **complexity**
(`spec.complexity.save_assessment`). A ``when: kind == feature and
complexity == complex`` condition is evaluated against this mapping.

A fact that is not there is simply absent from the mapping — the engine
reads an absent fact as matching, so a card from before the kind existed, or
a spec whose assessment was skipped, runs the conditional phase rather than
losing it.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["task_facts"]

_ASSESSMENT_FILE = "complexity_assessment.json"


def task_facts(spec_dir: Path | None) -> dict[str, str]:
    """``{"kind": …, "complexity": …}``, each present only when known."""
    facts: dict[str, str] = {}
    if spec_dir is None:
        return facts
    spec_dir = Path(spec_dir)
    try:
        from tasks.metadata import read_task_metadata

        kind = read_task_metadata(spec_dir).get("kind")
        if isinstance(kind, str) and kind:
            facts["kind"] = kind
    except Exception as exc:  # noqa: BLE001 - advisory
        logger.debug("task kind unavailable for %s: %s", spec_dir, exc)
    try:
        path = spec_dir / _ASSESSMENT_FILE
        if path.is_file():
            data: Any = json.loads(path.read_text(encoding="utf-8"))
            level = data.get("complexity") if isinstance(data, dict) else None
            if isinstance(level, str) and level:
                facts["complexity"] = level.lower()
    except (OSError, ValueError) as exc:
        logger.debug("complexity unavailable for %s: %s", spec_dir, exc)
    return facts
