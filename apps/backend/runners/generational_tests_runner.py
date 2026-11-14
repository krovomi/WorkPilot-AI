"""Generational tests: run the project's own suite once, then capture or compare.

Pasting a report works for any stack (``generational_tests.reports``), but
most people have no report at hand: this runner runs the suite with the flag
that makes the stack write one (``suite_runner.runs``, the flaky detective's
runner: .NET, pytest, Vitest, Jest, node --test, Maven, Gradle, Go, Cargo,
PHPUnit/Pest, RSpec, Dart/Flutter, Swift) and stores the outcomes as a
generation, or diffs them against a baseline.

The command is one of the stack's own, detected from the project's manifests;
the caller only names its id. It runs without a shell, in the project's
folder, without the backend's credentials.

Modes: ``detect`` (the commands this project has), ``capture`` (``--label``),
``compare`` (``--baseline``).

Output protocol (one line, prefixed):
    GEN_RESULT:{...}
    GEN_ERROR:"<code>: <message>"   (a JSON string)
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from generational_tests import GenerationalArchive, TestOutcome  # noqa: E402
from generational_tests.reports import ReportError, parse_report_file  # noqa: E402
from suite_runner.dotnet import has_dotnet_projects  # noqa: E402
from suite_runner.runs import (  # noqa: E402
    COMMAND_IDS,
    RunOutcome,
    TestCommand,
    detect_test_commands,
    install_cancel_handler,
    run_once,
)

#: Each run's reports and log, relative to the project.
RUNS_DIR = GenerationalArchive.DEFAULT_SUBDIR / "runs"
#: Older runs are removed: a generation keeps its outcomes, not its logs.
KEEP_RUNS = 5
#: Where Maven and Gradle write their reports (the run collects what changed).
REPORT_GLOBS = ("**/target/surefire-reports/*.xml", "**/build/test-results/**/*.xml")


class RunError(Exception):
    """The suite gave no outcome; the message starts with a code the UI translates."""


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def pick_command(project: Path, command_id: str) -> TestCommand:
    detected = detect_test_commands(project)
    if command_id == "auto":
        if detected:
            return detected[0]
    else:
        for command in detected:
            if command.id == command_id:
                return command
    if command_id in ("auto", "dotnet") and has_dotnet_projects(project):
        raise RunError("no_dotnet_tests: this .NET project has no test project")
    raise RunError(f"no_command: no {command_id} test command in this project")


def _prune(runs_root: Path) -> None:
    runs = sorted((p for p in runs_root.iterdir() if p.is_dir()), reverse=True)
    for old in runs[KEEP_RUNS:]:
        shutil.rmtree(old, ignore_errors=True)


def _outcomes(outcome: RunOutcome, project: Path) -> list[TestOutcome]:
    found: list[TestOutcome] = []
    for report in outcome.reports:
        try:
            found.extend(parse_report_file(report, project)[1])
        except ReportError:
            # A report of the run that holds no test (one test project of
            # several): the others still count.
            continue
    return found


def run_suite(
    project: Path, command_id: str, timeout_s: float
) -> tuple[TestCommand, list[TestOutcome]]:
    """Run the suite once and read every report it wrote."""
    command = pick_command(project, command_id)
    runs_root = project / RUNS_DIR
    outcome = run_once(
        command,
        project,
        runs_root / time.strftime("%Y%m%d-%H%M%S"),
        timeout_s=timeout_s,
        report_globs=REPORT_GLOBS,
    )
    _prune(runs_root)
    if outcome.error:
        raise RunError(f"start_failed: {outcome.error}")
    if outcome.timed_out:
        raise RunError(f"timed_out: {command.command}")
    outcomes = _outcomes(outcome, project)
    if not outcomes:
        code = "no_tests" if outcome.exit_code == 0 else "no_results"
        raise RunError(
            f"{code}: {command.command} (exit code {outcome.exit_code})\n"
            f"{outcome.output_tail[-4000:]}"
        )
    return command, outcomes


def capture(project: Path, label: str, command_id: str, timeout_s: float) -> dict:
    archive = GenerationalArchive(project_dir=project)
    archive.validate_label(label)  # refuse a bad label before a long run
    command, outcomes = run_suite(project, command_id, timeout_s)
    gen = archive.capture(
        label, outcomes=outcomes, junit_source=f"run:{command.command}"
    )
    return {
        "label": gen.label,
        "command": command.command,
        "outcome_count": len(gen.outcomes),
        "passing_count": len(gen.passing_ids),
    }


def compare(project: Path, baseline: str, command_id: str, timeout_s: float) -> dict:
    archive = GenerationalArchive(project_dir=project)
    if archive.load(baseline) is None:
        raise RunError(f"no_baseline: {baseline}")
    command, outcomes = run_suite(project, command_id, timeout_s)
    report = archive.compare(baseline, current_outcomes=outcomes)
    return {"command": command.command, "report": report.to_dict()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generational tests runner")
    parser.add_argument("--project-path", required=True)
    parser.add_argument(
        "--mode", choices=("detect", "capture", "compare"), required=True
    )
    parser.add_argument("--label", default="")
    parser.add_argument("--baseline", default="")
    parser.add_argument("--command-id", choices=("auto", *COMMAND_IDS), default="auto")
    parser.add_argument("--timeout", type=float, default=1800.0)
    args = parser.parse_args(argv)

    project = Path(args.project_path).resolve()
    if not project.is_dir():
        _emit("GEN_ERROR", "not_a_directory: the project folder does not exist")
        return 1
    timeout_s = max(30.0, min(args.timeout, 7200.0))
    try:
        if args.mode == "detect":
            commands = [c.to_dict() for c in detect_test_commands(project)]
            result: dict = {"commands": commands}
        elif args.mode == "capture":
            install_cancel_handler()
            result = capture(project, args.label, args.command_id, timeout_s)
        else:
            install_cancel_handler()
            result = compare(project, args.baseline, args.command_id, timeout_s)
    except (RunError, OSError) as exc:
        _emit("GEN_ERROR", str(exc))
        return 1
    except ValueError as exc:
        # The archive refuses a label or a baseline it cannot read.
        _emit("GEN_ERROR", f"invalid: {exc}")
        return 1
    _emit("GEN_RESULT", result)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
