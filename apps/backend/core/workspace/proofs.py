"""The project's proof checkers, run against a task's worktree (lot 6, P2).

A project that keeps formal proofs (Dafny, Lean, Verus for Rust, F*, Coq…)
declares how to check them in the `[proofs]` table of `.workpilot/worktree.toml`:

    [proofs]
    commands = [["dafny", "verify", "src/Cart.dfy"]]
    timeout_seconds = 600

A proof checker is deterministic and has no false green: a proof a model got
wrong is rejected. That makes it a hard gate WorkPilot can trust, the
`proof-checks` gate, run by QA once the reviewer approves.

The recipe is read from the project, never from the worktree, and runs only
once the person approved it as it is (the recipe's fingerprint covers the
proofs): an agent that edits `worktree.toml` in its branch changes nothing
that runs. Commands are argument lists without a shell (rule 6), in the
worktree, with an environment stripped of credentials.

Verdicts: ``pass`` (every checker exited 0), ``fail`` (one exited non-zero),
``unknown`` (a checker is not installed, ran out of time, the recipe is not
approved or is invalid), ``none`` (the project declares no proof). Only
``fail`` blocks; ``unknown`` is never a pass.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

from .recipe import Recipe, load_recipe
from .recipe_run import _environment, _expand, _run, _variables, is_approved

__all__ = [
    "PROOF_RECORD",
    "ProofReport",
    "load_proof_record",
    "main_project_of",
    "run_proofs",
    "write_proof_record",
]

PROOF_RECORD = "proof_checks.json"
PASS, FAIL, UNKNOWN, NONE = "pass", "fail", "unknown", "none"


@dataclass
class ProofReport:
    status: str
    reason: str = ""
    checks: list[dict] = field(default_factory=list)
    at: str = ""

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if c.get("status") == "failed"]


def main_project_of(worktree: Path) -> Path:
    """The project a task worktree belongs to (the git common dir's parent)."""
    result = run_git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=worktree
    )
    common = (result.stdout or "").strip() if result.returncode == 0 else ""
    if not common:
        return worktree
    return Path(common).parent


class _Log:
    """`_run` writes what it ran; the record keeps the tail per check."""

    def write(self, _text: str) -> None:
        return None


def run_proofs(
    project_dir: Path | str,
    worktree: Path | str,
    spec_name: str,
    recipe: Recipe | None = None,
) -> ProofReport:
    """Run the approved proof checkers in ``worktree``. Never raises."""
    project_dir, worktree = Path(project_dir), Path(worktree)
    at = datetime.now(UTC).isoformat(timespec="seconds")
    recipe = recipe if recipe is not None else load_recipe(project_dir)
    if recipe is None or (not recipe.errors and not recipe.proofs):
        return ProofReport(NONE, "the project declares no proof checker", at=at)
    if recipe.errors:
        return ProofReport(
            UNKNOWN, "worktree.toml is invalid: " + "; ".join(recipe.errors), at=at
        )
    if not is_approved(project_dir, recipe):
        return ProofReport(
            UNKNOWN, "worktree.toml is not approved as it is: nothing ran", at=at
        )
    variables = _variables(project_dir, worktree, spec_name, None, 0)
    env = _environment(recipe, variables)
    deadline = time.monotonic() + recipe.proof_timeout_seconds
    report = ProofReport(PASS, at=at)
    for command in recipe.proofs:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            step = {
                "command": list(command),
                "status": "timeout",
                "detail": "the proofs' time ran out",
            }
        else:
            expanded = tuple(_expand(a, variables) for a in command)
            done = _run(expanded, worktree, env, remaining, _Log())
            step = {
                "command": list(command),
                "status": done.status,
                "detail": done.detail,
                "seconds": round(done.seconds, 1),
            }
        report.checks.append(step)
    statuses = {c["status"] for c in report.checks}
    if "failed" in statuses:
        report.status = FAIL
        report.reason = "a proof checker rejected the proofs"
    elif statuses - {"ok"}:
        report.status = UNKNOWN
        report.reason = "a proof checker is not installed or ran out of time"
    else:
        report.reason = f"{len(report.checks)} proof checker(s) passed"
    return report


def write_proof_record(spec_dir: Path | str, report: ProofReport) -> None:
    path = Path(spec_dir) / PROOF_RECORD
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_proof_record(spec_dir: Path | str) -> dict | None:
    path = Path(spec_dir) / PROOF_RECORD
    if path.is_symlink():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
