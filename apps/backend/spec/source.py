"""The description a spec was written from.

A spec is written once; the task's description can change after that (an
edit, a duplicated task retitled and re-described). The launcher used to
read "spec.md exists" as "spec is up to date", so a task asking for
`tata.txt` ran on a spec asking for `toto.txt`, and QA, judging against that
spec, deleted `tata.txt` (report of 2 November).

When a spec is complete, the `task_description` of `requirements.json` it was
written from is recorded next to it. The frontend compares that record with
the current `requirements.json` before each start and regenerates the spec
when they differ (`ipc-handlers/task/stale-spec.ts`). A spec without a
record (written before this file existed) is trusted as it is.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

SPEC_SOURCE_FILE = "spec_source.json"


def record_spec_source(spec_dir: Path) -> bool:
    """Record the requirements' description next to a finished spec.

    Returns False (and records nothing) when requirements.json has no
    readable description: no record means "trusted", never "stale".
    """
    try:
        req = json.loads((spec_dir / "requirements.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    description = req.get("task_description") if isinstance(req, dict) else None
    if not isinstance(description, str) or not description.strip():
        return False
    record = {
        "task_description": description,
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    try:
        (spec_dir / SPEC_SOURCE_FILE).write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError as exc:
        logger.warning("Could not record the spec source in %s: %s", spec_dir, exc)
        return False
    return True
