"""What rtk has actually saved, read from rtk's own ledger.

rtk records every command it proxied in a local database and exposes it with
`rtk gain --format json`. That record is the only honest source: WorkPilot can
count the commands it rewrote, but only rtk knows how many bytes came in and
how many went out.

The number is a byte count, not a bill. rtk has no tokenizer and estimates
tokens as bytes / 4, and shell output is one input among prompts, history and
system instructions — which are themselves only the input half of a bill that
also pays for output. So this module reports what was measured, names it as an
estimate, and leaves the extrapolation to nobody.

Scoped to the project by default (`--project` filters on the working
directory): "how much has rtk saved me" asked from a task panel is a question
about this repository, and an answer pooled over every project on the machine
is a number the user cannot act on.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .runtime import is_usable, rtk_binary

logger = logging.getLogger(__name__)

__all__ = ["Savings", "read_savings"]

_TIMEOUT = 5.0

#: rtk's own estimate: it ships no tokenizer, and neither do we. Duplicating
#: the ratio here rather than inventing one keeps the two numbers comparable
#: when a user runs `rtk gain` in a terminal and reads this panel.
_BYTES_PER_TOKEN = 4


@dataclass(frozen=True)
class Savings:
    """The ledger, as it stands. Every field is zero when there is nothing yet."""

    available: bool
    commands: int = 0
    input_bytes: int = 0
    output_bytes: int = 0
    saved_bytes: int = 0
    average_pct: float = 0.0
    #: Why there is no number, when there is no number.
    reason: str = ""

    @property
    def saved_tokens(self) -> int:
        return self.saved_bytes // _BYTES_PER_TOKEN

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "commands": self.commands,
            "inputBytes": self.input_bytes,
            "outputBytes": self.output_bytes,
            "savedBytes": self.saved_bytes,
            "savedTokens": self.saved_tokens,
            "averagePct": round(self.average_pct, 1),
            "reason": self.reason,
        }


def read_savings(project_dir: Path | str | None = None) -> Savings:
    """The savings rtk has recorded, for this project or for everything.

    Read-only and cheap — one exec against a local database. Never raises: a
    panel asking for a number gets "not available" and a reason, never a 500.
    """
    if not is_usable():
        return Savings(available=False, reason="rtk is not available here")
    binary = rtk_binary()
    if not binary:  # pragma: no cover - is_usable already checked
        return Savings(available=False, reason="rtk is not installed")

    argv = [binary, "gain", "--format", "json"]
    if project_dir is not None:
        argv.append("--project")

    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT,
            cwd=str(project_dir) if project_dir else None,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("rtk gain failed: %s", exc)
        return Savings(available=False, reason="rtk gain could not be read")

    if proc.returncode != 0:
        return Savings(available=False, reason="rtk gain returned no data")

    try:
        payload = json.loads(proc.stdout or "{}")
        summary = payload.get("summary") or {}
    except (ValueError, AttributeError):
        return Savings(available=False, reason="rtk gain output was not readable")

    return Savings(
        available=True,
        commands=int(summary.get("total_commands", 0) or 0),
        input_bytes=int(summary.get("total_input", 0) or 0),
        output_bytes=int(summary.get("total_output", 0) or 0),
        saved_bytes=int(summary.get("total_saved", 0) or 0),
        average_pct=float(summary.get("avg_savings_pct", 0.0) or 0.0),
    )
