"""The stack's own mutation tool, when the project has it, limited to the diff.

WorkPilot reads the tool's report file, never its console output:

- StrykerJS (``@stryker-mutator/core`` in the project's devDependencies):
  ``stryker run --mutate <file>:<first>-<last> --reporters json``, read from
  ``reports/mutation/mutation.json`` (the mutation-testing-report schema,
  which Stryker.NET writes too);
- cargo-mutants (on PATH): ``cargo mutants --in-diff <diff>``, read from
  ``mutants.out/outcomes.json``.

Anything else, or a tool that fails or writes no report, falls back to the
generic mutator: the native engine is a better measure when it exists, never
a condition for having one.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

__all__ = [
    "NativePlan",
    "native_plan",
    "read_cargo_mutants",
    "read_mutation_report",
]

#: The schema's statuses a test detected, and those it did not.
_DETECTED = frozenset({"Killed", "Timeout"})
_UNDETECTED = frozenset({"Survived", "NoCoverage"})
_CARGO_DETECTED = frozenset({"CaughtMutant", "Timeout"})
_CARGO_UNDETECTED = frozenset({"MissedMutant"})


class NativePlan:
    """One native run: its argv, where it runs, and how its report is read."""

    def __init__(self, engine: str, argv: list[str], report: str, reader):
        self.engine = engine
        self.argv = argv
        self.report = report
        self.reader = reader


def _devdeps(root: Path) -> dict:
    try:
        data = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}


def _span(lines: set[int]) -> str:
    return f"{min(lines)}-{max(lines)}"


def native_plan(
    root: Path, files: dict[str, set[int]], diff_file: Path | None
) -> NativePlan | None:
    """The native run for these files (relative to ``root``), or None."""
    if not files:
        return None
    suffixes = {Path(f).suffix.lower() for f in files}
    js = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
    if suffixes <= js and "@stryker-mutator/core" in _devdeps(root):
        mutate = [f"{path}:{_span(lines)}" for path, lines in sorted(files.items())]
        return NativePlan(
            "stryker",
            [
                "npx",
                "stryker",
                "run",
                "--reporters",
                "json",
                "--mutate",
                ",".join(mutate),
            ],
            "reports/mutation/mutation.json",
            read_mutation_report,
        )
    if suffixes == {".rs"} and diff_file is not None and shutil.which("cargo-mutants"):
        return NativePlan(
            "cargo-mutants",
            ["cargo", "mutants", "--in-diff", str(diff_file), "--no-shuffle"],
            "mutants.out/outcomes.json",
            read_cargo_mutants,
        )
    return None


def read_mutation_report(data: object) -> list[dict]:
    """The mutation-testing-report schema (Stryker JS / .NET) → results."""
    files = data.get("files") if isinstance(data, dict) else None
    results: list[dict] = []
    for path, entry in (files or {}).items() if isinstance(files, dict) else []:
        for mutant in (entry or {}).get("mutants") or []:
            if not isinstance(mutant, dict):
                continue
            status = str(mutant.get("status") or "")
            if status in _DETECTED:
                outcome = "killed"
            elif status in _UNDETECTED:
                outcome = "survived"
            else:
                continue  # CompileError, RuntimeError, Ignored: not a measure
            start = ((mutant.get("location") or {}).get("start") or {}).get("line")
            results.append(
                {
                    "path": str(path).replace("\\", "/"),
                    "line": start if isinstance(start, int) else 0,
                    "description": str(mutant.get("mutatorName") or "mutant")
                    + (
                        f" → {mutant['replacement']}"
                        if mutant.get("replacement")
                        else ""
                    ),
                    "outcome": outcome,
                }
            )
    return results


def read_cargo_mutants(data: object) -> list[dict]:
    """cargo-mutants' ``outcomes.json`` → results."""
    outcomes = data.get("outcomes") if isinstance(data, dict) else None
    results: list[dict] = []
    for item in outcomes or []:
        if not isinstance(item, dict):
            continue
        summary = str(item.get("summary") or "")
        if summary in _CARGO_DETECTED:
            outcome = "killed"
        elif summary in _CARGO_UNDETECTED:
            outcome = "survived"
        else:
            continue  # Success (the baseline), Unviable
        scenario = item.get("scenario")
        mutant = scenario.get("Mutant") if isinstance(scenario, dict) else None
        if not isinstance(mutant, dict):
            continue
        span = mutant.get("span") or {}
        start = (span.get("start") or {}).get("line")
        results.append(
            {
                "path": str(mutant.get("file") or "").replace("\\", "/"),
                "line": start if isinstance(start, int) else 0,
                "description": str(
                    mutant.get("replacement") or mutant.get("genre") or "mutant"
                ),
                "outcome": outcome,
            }
        )
    return results
