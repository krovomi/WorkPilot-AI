"""Do the tests bite? Targeted mutation testing on the task's diff (F7).

Coverage says a line ran, not that a test would fail if the line were wrong:
a test that builds the object and checks it is not null satisfies it. This
package inverts a few operators on the lines the task wrote, one at a time,
in a throwaway copy of the worktree, and runs the tests of each mutated file.
A mutant the tests do not notice is a missing test.

- ``mutator``: the generic lexical mutator, any stack, never in a comment or
  a string;
- ``native``: StrykerJS and cargo-mutants when the project has them;
- ``scope``: the lines to mutate, from git;
- ``commands``: the stack's test command, as an argument list;
- ``sandbox``: the throwaway copy, removed in a ``finally``;
- ``engine``: the run and the score.

The QA gate that calls it is ``qa/mutation_gate.py``; the hard gate
``tests-bite`` (``workflows/hard_gates.py``) reads the record written here,
``<spec_dir>/mutation_gate.json``. A leaf: foundation and the child
environment of security only. See ``docs/architecture/mutation-gate.md``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from .engine import MutationReport, run_mutation_gate
from .mutator import Mutant, mutants_for

logger = logging.getLogger(__name__)

__all__ = [
    "RECORD_FILE",
    "Mutant",
    "MutationReport",
    "load_record",
    "mutants_for",
    "run_mutation_gate",
    "write_record",
]

RECORD_FILE = "mutation_gate.json"


def write_record(spec_dir: Path, report: MutationReport | dict) -> None:
    data = report.to_dict() if isinstance(report, MutationReport) else report
    spec_dir = Path(spec_dir)
    fd, tmp = tempfile.mkstemp(dir=spec_dir, prefix=".mutation-gate-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, spec_dir / RECORD_FILE)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_record(spec_dir: Path) -> dict | None:
    """The last gate's record, None when the gate never ran here."""
    try:
        data = json.loads((Path(spec_dir) / RECORD_FILE).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("could not read %s: %s", RECORD_FILE, exc)
        return None
    return data if isinstance(data, dict) else None
