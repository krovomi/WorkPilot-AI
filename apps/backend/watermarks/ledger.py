"""A record of every silent edit, because a silent edit needs one.

This is the only place in a build where WorkPilot changes bytes a model wrote
without telling it. That is the right call — the characters are invisible, so
an awareness paragraph would warn a model about something it cannot observe,
and the one thing it could then do with the warning is doubt correct output.
But "the model is not told" and "nobody is told" are different, and the second
one is not acceptable for a pass that edits generated code.

So each change appends one line to `<spec_dir>/watermarks.jsonl`: the file, the
tool, and the codepoints removed, by name. A reviewer asking "why does this
line differ from what the transcript shows the agent wrote?" has the answer in
the spec directory, next to the plan and the QA report.

Nothing here can fail a build. No spec directory, a read-only disk, a full
disk: the line is dropped and the cleaning still happened.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from .clean import Cleaning

logger = logging.getLogger(__name__)

__all__ = ["LEDGER_NAME", "read_entries", "record"]

LEDGER_NAME = "watermarks.jsonl"

#: Past this the ledger stops growing. A pathological build that rewrites one
#: file ten thousand times should not leave a bigger artifact than the code it
#: produced, and the first entries are the ones that explain the run.
_MAX_LEDGER_BYTES = 512 * 1024


def record(
    spec_dir: Path | str | None,
    *,
    file_path: str,
    tool: str,
    cleaning: Cleaning,
) -> bool:
    """Append one line for a cleaning that changed something. Returns whether it landed."""
    if spec_dir is None or not cleaning.changed:
        return False
    target = Path(spec_dir) / LEDGER_NAME
    try:
        if target.is_file() and target.stat().st_size >= _MAX_LEDGER_BYTES:
            return False
        entry = {
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tool": tool,
            "file": file_path,
            "removed": cleaning.removed,
            "replaced": cleaning.replaced,
            "removed_count": cleaning.removed_count,
            "replaced_count": cleaning.replaced_count,
            "pid": os.getpid(),
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return True
    except OSError:
        logger.debug("watermarks: could not append to %s", target, exc_info=True)
        return False


def read_entries(spec_dir: Path | str | None) -> list[dict]:
    """Every recorded cleaning for a spec, oldest first. Empty when there is none.

    A malformed line is skipped rather than raised on: the ledger is evidence,
    and evidence that refuses to be read because one line was truncated by a
    crash is worse than evidence with a gap.
    """
    if spec_dir is None:
        return []
    target = Path(spec_dir) / LEDGER_NAME
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    entries: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            entries.append(parsed)
    return entries
