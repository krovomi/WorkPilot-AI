"""
Flaky Tests Runner

Discovers test reports in a project, builds a TestRun history, and runs
the FlakyAnalyzer to identify flaky tests.

Two report formats are understood:
    * JUnit XML (``<testsuite>``/``<testcase>``) — pytest, jest, Maven
      surefire, and ``dotnet test --logger junit``.
    * TRX (``<TestRun>``/``<UnitTestResult>``) — the *native* format
      emitted by ``dotnet test --logger trx`` / ``vstest.console``. .NET
      projects produce TRX by default, never JUnit, so a JUnit-only
      detective always reported "0 tests" on a C# solution.

Three modes: ``scan`` reads the reports already in the project (the runs
kept by ``run`` included), ``run`` runs the project's test command N times
(``suite_runner.runs``) and analyses those runs, ``detect``
lists the test commands the project's stack has.

Output protocol (one JSON value per line, prefixed):
    FLAKY_EVENT:{"type": "progress", "data": {"status": "...", "code": "..."}}
    FLAKY_RESULT:{...full report dict...}
    FLAKY_ERROR:"<code>: <message>"   (a JSON string; it may hold newlines)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from flaky_test_detective.flaky_analyzer import (  # noqa: E402
    FlakyAnalyzer,
    TestRun,
)
from suite_runner.runs import (  # noqa: E402
    COMMAND_IDS,
    HISTORY_DIR,
    TestCommand,
    detect_test_commands,
    install_cancel_handler,
    run_once,
)

REPORT_GLOBS = [
    # JUnit XML
    "**/test-results/**/*.xml",
    "**/junit*.xml",
    "**/TEST-*.xml",
    "**/*.junit.xml",
    "**/build/test-results/**/*.xml",
    "**/target/surefire-reports/*.xml",
    "**/reports/junit/*.xml",
    # TRX (native .NET / vstest) — dotnet test --logger trx writes here
    "**/*.trx",
    "**/TestResults/**/*.trx",
]
DEFAULT_IGNORES = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "bin",
    "obj",
}


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("FLAKY_EVENT", {"type": event_type, "data": data})


def _discover_reports(root: Path) -> list[Path]:
    found: set[Path] = set()
    for pattern in REPORT_GLOBS:
        for path in root.glob(pattern):
            if path.is_file() and not any(
                part in DEFAULT_IGNORES for part in path.parts
            ):
                found.add(path)
    return sorted(found)


def _local(tag: str) -> str:
    """Return the local part of a (possibly namespaced) XML tag.

    TRX documents declare a default namespace, so ElementTree reports
    tags as ``{http://…/2010}UnitTestResult``. Matching on the local
    name keeps the parser namespace-agnostic.
    """
    return tag.rsplit("}", 1)[-1]


def _iter_local(root: ET.Element, name: str):
    """Yield descendant elements whose local tag name equals ``name``."""
    for el in root.iter():
        if _local(el.tag) == name:
            yield el


# --- JUnit ------------------------------------------------------------


def _testcase_full_name(case: ET.Element) -> str:
    name = case.attrib.get("name", "")
    classname = case.attrib.get("classname", "")
    return f"{classname}::{name}" if classname else name


def _testcase_duration(case: ET.Element) -> float:
    try:
        return float(case.attrib.get("time", "0")) * 1000
    except ValueError:
        return 0.0


def _testcase_error_message(case: ET.Element) -> tuple[bool, str]:
    """Return (passed, error_message). Skipped tests yield (True, "")."""
    failure = case.find("failure")
    error = case.find("error")
    if failure is not None:
        return False, failure.attrib.get("message", "") or (failure.text or "")
    if error is not None:
        return False, error.attrib.get("message", "") or (error.text or "")
    return True, ""


def _parse_junit_root(root: ET.Element, run_id: str, timestamp: float) -> list[TestRun]:
    runs: list[TestRun] = []
    for case in _iter_local(root, "testcase"):
        if any(_local(c.tag) == "skipped" for c in case):
            continue
        passed, error_message = _testcase_error_message(case)
        runs.append(
            TestRun(
                test_name=_testcase_full_name(case),
                passed=passed,
                duration_ms=_testcase_duration(case),
                error_message=error_message[:500],
                run_id=run_id,
                timestamp=timestamp,
            )
        )
    return runs


# --- TRX (native .NET / vstest) ---------------------------------------

# TRX outcomes that mean "the test did not run" — treated like a JUnit
# <skipped> and excluded from flakiness accounting.
_TRX_SKIPPED_OUTCOMES = {"notexecuted", "inconclusive", "pending", "warning"}


def _trx_duration(result: ET.Element) -> float:
    """Parse a TRX ``duration`` attribute (``HH:MM:SS.fffffff``) to ms."""
    raw = result.attrib.get("duration", "")
    if not raw:
        return 0.0
    try:
        hms, _, frac = raw.partition(".")
        hours, minutes, seconds = (int(p) for p in hms.split(":"))
        total = hours * 3600 + minutes * 60 + seconds
        frac_ms = float(f"0.{frac}") * 1000 if frac else 0.0
        return total * 1000 + frac_ms
    except (ValueError, TypeError):
        return 0.0


def _trx_error_message(result: ET.Element) -> str:
    for msg in _iter_local(result, "Message"):
        if msg.text:
            return msg.text
    return ""


def _parse_trx_root(root: ET.Element, run_id: str, timestamp: float) -> list[TestRun]:
    runs: list[TestRun] = []
    for result in _iter_local(root, "UnitTestResult"):
        outcome = result.attrib.get("outcome", "").lower()
        if outcome in _TRX_SKIPPED_OUTCOMES:
            continue
        name = result.attrib.get("testName", "")
        passed = outcome == "passed"
        error_message = "" if passed else _trx_error_message(result)
        runs.append(
            TestRun(
                test_name=name,
                passed=passed,
                duration_ms=_trx_duration(result),
                error_message=error_message[:500],
                run_id=run_id,
                timestamp=timestamp,
            )
        )
    return runs


def _parse_report_file(path: Path, run_id: str) -> list[TestRun]:
    """Parse a report file, dispatching on the actual root element.

    The root tag (not the extension) decides the format so a JUnit XML
    saved with a ``.xml`` name and a TRX with a ``.trx`` name both work.
    """
    try:
        tree = ET.parse(path)  # noqa: S314
    except (ET.ParseError, OSError):
        return []

    root = tree.getroot()
    timestamp = path.stat().st_mtime
    root_tag = _local(root.tag).lower()

    if root_tag == "testrun":  # TRX
        return _parse_trx_root(root, run_id, timestamp)
    return _parse_junit_root(root, run_id, timestamp)


def _flaky_test_to_dict(test: Any) -> dict[str, Any]:
    return {
        "testName": test.test_name,
        "totalRuns": test.total_runs,
        "failures": test.failures,
        "flakinessRate": test.flakiness_rate,
        "probableCause": test.probable_cause.value,
        "confidence": test.confidence.value,
        "errorPatterns": test.error_patterns,
        "suggestedFix": test.suggested_fix,
    }


# Language detection → the command that makes that stack emit a
# machine-readable (JUnit XML / TRX) test report. Markers are either an
# exact filename or a ``*.ext`` extension pattern. Order defines the
# order languages appear in the guidance message.
_LANGUAGE_REPORT_HINTS: list[tuple[str, tuple[str, ...], str]] = [
    (
        "C# / .NET",
        ("*.sln", "*.csproj", "*.fsproj", "*.vbproj"),
        "dotnet test --logger trx",
    ),
    (
        "JavaScript / TypeScript",
        ("package.json",),
        "jest --reporters=default --reporters=jest-junit (or vitest --reporter=junit)",
    ),
    (
        "Python",
        ("pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "*.py"),
        "pytest --junitxml=test-results/junit.xml",
    ),
    (
        "Java / Kotlin",
        ("pom.xml", "build.gradle", "build.gradle.kts"),
        "mvn test (Surefire emits JUnit XML) or gradle test",
    ),
    (
        "Go",
        ("go.mod",),
        "gotestsum --junitfile test-results/junit.xml",
    ),
    (
        "Ruby",
        ("Gemfile",),
        "rspec --format RspecJunitFormatter --out test-results/junit.xml",
    ),
    (
        "Rust",
        ("Cargo.toml",),
        "cargo nextest run --profile ci (emits JUnit)",
    ),
    (
        "PHP",
        ("composer.json",),
        "phpunit --log-junit test-results/junit.xml",
    ),
]

# Stop walking once we've seen enough of the tree to identify the stack;
# keeps detection fast on very large monorepos.
_MAX_SCANNED_FILES = 20000


def _detect_languages(project_path: Path) -> list[tuple[str, str]]:
    """Detect project languages, returning ``(label, report_command)``."""
    from project.stack import detect_markers

    commands = {label: command for label, _markers, command in _LANGUAGE_REPORT_HINTS}
    found = detect_markers(
        project_path,
        [(label, markers) for label, markers, _command in _LANGUAGE_REPORT_HINTS],
        ignores=DEFAULT_IGNORES,
        max_files=_MAX_SCANNED_FILES,
    )
    return [(label, commands[label]) for label in found]


def _no_reports_message(project_path: Path) -> str:
    """Guidance for the empty state, tailored to the detected languages.

    Telling a C# developer to "emit XML reports" is confusing — .NET
    emits TRX, JS emits JUnit via jest-junit, etc. So we detect the
    project's languages and point at the right command for each.
    """
    detected = _detect_languages(project_path)
    if not detected:
        return (
            "No test reports found. Configure your test runner to emit "
            "JUnit XML or TRX reports, then re-scan."
        )
    hints = "; ".join(f"{label} → `{command}`" for label, command in detected)
    return (
        "No test reports found. Emit JUnit XML or TRX reports and re-scan. "
        f"Detected stack — {hints}."
    )


def _progress(code: str, status: str, **data: Any) -> None:
    """A progress event: ``code`` and its data for the UI to word, ``status``
    in English for any older reader."""
    _emit_event("progress", {"status": status, "code": code, **data})


def _always_failing(runs: list[TestRun], min_runs: int) -> list[str]:
    """Tests that failed in every run: broken, not flaky, but worth showing."""
    outcomes: dict[str, list[bool]] = {}
    for run in runs:
        outcomes.setdefault(run.test_name, []).append(run.passed)
    return sorted(
        name
        for name, results in outcomes.items()
        if len(results) >= min_runs and not any(results)
    )[:50]


def _build_report(
    project_path: Path,
    runs: list[TestRun],
    threshold: float,
    min_runs: int,
    *,
    mode: str,
    run_count: int,
    report_count: int,
) -> dict[str, Any]:
    detected = [c.to_dict() for c in detect_test_commands(project_path)]
    base: dict[str, Any] = {
        "mode": mode,
        "runCount": run_count,
        "reportCount": report_count,
        "detectedCommands": detected,
        "minRuns": min_runs,
    }
    if not runs:
        return {
            **base,
            "totalTests": 0,
            "flakyCount": 0,
            "flakyTests": [],
            "alwaysFailing": [],
            "summaryCode": "no_reports",
            "summary": _no_reports_message(project_path),
        }
    analyzer = FlakyAnalyzer(flakiness_threshold=threshold, min_runs=min_runs)
    report = analyzer.analyze(runs)
    return {
        **base,
        "totalTests": report.total_tests_analysed,
        "flakyCount": report.flaky_count,
        "flakyTests": [_flaky_test_to_dict(t) for t in report.flaky_tests],
        "alwaysFailing": _always_failing(runs, min_runs),
        "summaryCode": "flaky" if report.flaky_count else "no_flaky",
        "summary": report.summary,
    }


def run_scan(project_path: Path, threshold: float, min_runs: int) -> dict[str, Any]:
    """Read the reports already in the project, the kept runs included."""
    _emit_event(
        "start", {"status": "Discovering test reports...", "code": "discovering"}
    )
    report_files = _discover_reports(project_path)
    _progress(
        "parsing",
        f"Parsing {len(report_files)} test reports...",
        reports=len(report_files),
    )

    runs: list[TestRun] = []
    for idx, file in enumerate(report_files):
        runs.extend(_parse_report_file(file, run_id=f"{file.name}-{idx}"))

    result = _build_report(
        project_path,
        runs,
        threshold,
        min_runs,
        mode="scan",
        run_count=len(report_files),
        report_count=len(report_files),
    )
    _emit_event(
        "complete",
        {"flakyCount": result["flakyCount"], "totalTests": result["totalTests"]},
    )
    return result


class RunError(Exception):
    """The suite could not produce a single report; the message says why."""


def _pick_command(project_path: Path, command_id: str) -> TestCommand:
    """A command of the project's stack, never a command line from outside:
    the caller names one of the detected commands, or takes the first."""
    detected = detect_test_commands(project_path)
    if command_id in ("", "auto"):
        if not detected:
            raise RunError("no_command: no test command was detected in this project")
        return detected[0]
    for command in detected:
        if command.id == command_id:
            return command
    raise RunError(f"no_command: the {command_id} test command was not detected")


def run_repeated(
    project_path: Path,
    *,
    runs: int,
    command_id: str,
    threshold: float,
    min_runs: int,
    timeout_s: float,
) -> dict[str, Any]:
    """Run the suite ``runs`` times and analyse those runs together."""
    command = _pick_command(project_path, command_id)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    history = project_path / HISTORY_DIR / stamp
    _emit_event(
        "start",
        {
            "status": f"Running `{command.command}` {runs} times...",
            "code": "running",
            "command": command.command,
            "runs": runs,
        },
    )
    install_cancel_handler()

    all_runs: list[TestRun] = []
    produced = 0
    last_tail = ""
    for index in range(1, runs + 1):
        _progress(
            "run_started",
            f"Run {index}/{runs}: {command.command}",
            run=index,
            runs=runs,
        )
        outcome = run_once(
            command,
            project_path,
            history / f"run-{index:02d}",
            timeout_s=timeout_s,
            # The first run built the solution; the others test that build.
            no_build=produced > 0,
            report_globs=REPORT_GLOBS,
        )
        if outcome.error:
            raise RunError(f"start_failed: {outcome.error}")
        results: list[TestRun] = []
        for file in outcome.reports:
            results.extend(_parse_report_file(file, run_id=f"{stamp}-{index}"))
        if results:
            produced += 1
        else:
            last_tail = outcome.output_tail
        all_runs.extend(results)
        failed = sum(1 for r in results if not r.passed)
        _progress(
            "run_finished",
            f"Run {index}/{runs}: {len(results) - failed} passed, {failed} failed",
            run=index,
            runs=runs,
            passed=len(results) - failed,
            failed=failed,
            exitCode=outcome.exit_code,
            timedOut=outcome.timed_out,
            durationS=round(outcome.duration_s, 1),
        )
        if index == 1 and not results:
            # Nothing to analyse if the very first run wrote no report: a
            # build error, a missing tool. Running it again would not help.
            break

    if not all_runs:
        raise RunError(
            "no_results: the test command produced no test report.\n" + last_tail
        )

    _progress("analysing", f"Analysing {len(all_runs)} test results...")
    result = _build_report(
        project_path,
        all_runs,
        threshold,
        min_runs,
        mode="run",
        run_count=produced,
        report_count=produced,
    )
    result["command"] = command.command
    _emit_event(
        "complete",
        {"flakyCount": result["flakyCount"], "totalTests": result["totalTests"]},
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Flaky Tests Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--mode",
        choices=("scan", "run", "detect"),
        default="scan",
        help="scan: read existing reports; run: run the suite N times; "
        "detect: list the project's test commands",
    )
    parser.add_argument("--runs", type=int, default=5, help="Runs in run mode (2-50)")
    parser.add_argument(
        "--command-id",
        choices=("auto", *COMMAND_IDS),
        default="auto",
        help="Which detected test command to run",
    )
    parser.add_argument(
        "--timeout", type=float, default=1800, help="Seconds allowed per run"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.05,
        help="Flakiness rate threshold (0.0-1.0)",
    )
    parser.add_argument(
        "--min-runs",
        type=int,
        default=2,
        help="Minimum runs needed to assess flakiness",
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("FLAKY_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        if args.mode == "detect":
            commands = [c.to_dict() for c in detect_test_commands(project_path)]
            _emit("FLAKY_RESULT", {"detectedCommands": commands})
            return
        if args.mode == "run":
            result = run_repeated(
                project_path,
                runs=max(2, min(args.runs, 50)),
                command_id=args.command_id,
                threshold=args.threshold,
                min_runs=args.min_runs,
                timeout_s=max(10.0, args.timeout),
            )
        else:
            result = run_scan(project_path, args.threshold, args.min_runs)
        _emit("FLAKY_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("FLAKY_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
