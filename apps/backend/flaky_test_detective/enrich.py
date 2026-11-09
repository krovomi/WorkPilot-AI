"""The report's flaky tests, with what the code and the history say (#351).

For each flaky test: its verdict from the failure rate, its file and line, the
causes its body shows (with their lines), its stack, who touched it last, and
its history (first seen, trend, systems, CI only). A run of the suite adds one
observation to the history; reading reports already there does not, since the
same report would be counted again at each scan.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

from .flaky_analyzer import _CAUSE_FIXES, FlakyCause, TestRun
from .history import load_history, record, summary
from .insights import find_test_files, locate_test, source_causes, stack_of, verdict

__all__ = ["enrich_report", "outcomes_of"]

_MAX_LOCATED = 40


def outcomes_of(runs: list[TestRun]) -> dict[str, tuple[int, int]]:
    """``{test: (runs, failures)}``."""
    counts: dict[str, list[int]] = {}
    for run in runs:
        entry = counts.setdefault(run.test_name, [0, 0])
        entry[0] += 1
        entry[1] += 0 if run.passed else 1
    return {name: (total, failed) for name, (total, failed) in counts.items()}


def _last_author(root: Path, path: str) -> str:
    result = run_git(["log", "-1", "--format=%an", "--", path], cwd=root, timeout=10)
    return result.stdout.strip()[:80] if result.returncode == 0 else ""


def enrich_report(
    root: Path,
    flaky: list[dict[str, Any]],
    runs: list[TestRun],
    command_ids: list[str],
    *,
    keep_history: bool,
) -> None:
    """Add verdict, location, causes, stack, author and history to each entry, in place."""
    history = record(root, outcomes_of(runs)) if keep_history else load_history(root)
    files = find_test_files(root) if flaky else []
    for index, entry in enumerate(flaky):
        entry["verdict"] = verdict(float(entry.get("flakinessRate") or 0.0))
        entry["history"] = summary(history.get(entry["testName"]))
        location = (
            locate_test(root, entry["testName"], files)
            if index < _MAX_LOCATED
            else None
        )
        if location is None:
            entry.update(
                {
                    "file": "",
                    "line": 0,
                    "stack": "other",
                    "sourceCauses": [],
                    "lastAuthor": "",
                }
            )
            continue
        causes = [cause.to_dict() for cause in source_causes(location)]
        entry.update(
            {
                "file": location.path,
                "line": location.line,
                "stack": stack_of(location.path, command_ids),
                "sourceCauses": causes,
                "lastAuthor": _last_author(root, location.path),
            }
        )
        # The error messages said nothing: the code says more.
        if entry.get("probableCause") == "unknown" and causes:
            entry["probableCause"] = causes[0]["cause"]
            entry["confidence"] = "medium" if len(causes[0]["evidence"]) > 1 else "low"
            entry["suggestedFix"] = entry.get("suggestedFix") or _CAUSE_FIXES.get(
                FlakyCause(causes[0]["cause"]), ""
            )
