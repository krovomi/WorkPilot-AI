"""The red team: an agent tries to break what the task built (F186, #381).

The QA reviewer checks that the code does what the spec says; the red team
attacks it. After QA approves, a session writes attack tests (malformed input,
limits, prompt injection, concurrency, past bugs) in the project's own test
framework, in a throwaway copy of the worktree; WorkPilot runs them itself.
An attack that makes an unhandled programming error escape from the changed
code is a crash and sends the fixer back. Later QA passes replay the same
attacks without a model.

- ``surface``: what to attack, and the static concurrency warnings;
- ``payloads``: the catalog of hostile inputs;
- ``prompt``: the session's prompt;
- ``reports``: the runners' machine reports, and crash vs unexpected;
- ``engine``: the run, in the scratch copy of ``mutation_gate.sandbox``.

The QA gate is ``qa/red_team_gate.py``; the hard gate ``attack-resistant``
(``workflows/hard_gates.py``) reads the record written here,
``<spec_dir>/red_team.json``; the card's route is ``qa/red_team_api.py``. See ``docs/architecture/red-team.md``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from .engine import MANIFEST, Attack, RedTeamReport, run_red_team

logger = logging.getLogger(__name__)

__all__ = [
    "MANIFEST",
    "RECORD_FILE",
    "Attack",
    "RedTeamReport",
    "load_record",
    "run_red_team",
    "write_record",
]

RECORD_FILE = "red_team.json"


def write_record(spec_dir: Path, report: RedTeamReport | dict) -> None:
    data = report.to_dict() if isinstance(report, RedTeamReport) else report
    spec_dir = Path(spec_dir)
    fd, tmp = tempfile.mkstemp(dir=spec_dir, prefix=".red-team-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, spec_dir / RECORD_FILE)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_record(spec_dir: Path) -> dict | None:
    """The last run's record, None when the red team never ran here."""
    try:
        data = json.loads((Path(spec_dir) / RECORD_FILE).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("could not read %s: %s", RECORD_FILE, exc)
        return None
    return data if isinstance(data, dict) else None
