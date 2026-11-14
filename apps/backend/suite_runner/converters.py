"""JUnit XML from the stacks whose test runner writes another format.

The detective reads JUnit XML and TRX. ``go test -json``, Jest's ``--json``,
``cargo test``'s console output, the Dart/Flutter JSON reporter and RSpec's
``--format json`` say the same thing in their own words: each converter writes
one ``<testsuite>`` with a ``<testcase>`` per test (``classname`` = package,
file or module; ``name`` = the test) and returns None when no test ran.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

__all__ = [
    "cargo_output_to_junit",
    "dart_json_to_junit",
    "go_json_to_junit",
    "jest_json_to_junit",
    "rspec_json_to_junit",
]

#: (classname, name, outcome, seconds, message) — outcome: pass, fail, skip.
_Case = tuple[str, str, str, float, str]


def _write(cases: list[_Case], suite_name: str, out_file: Path) -> Path | None:
    if not cases:
        return None
    suite = ET.Element("testsuite", name=suite_name, tests=str(len(cases)))
    for classname, name, outcome, seconds, message in cases:
        case = ET.SubElement(
            suite, "testcase", classname=classname, name=name, time=f"{seconds:.3f}"
        )
        if outcome == "fail":
            failure = ET.SubElement(case, "failure", message=message.strip()[:500])
            failure.text = message[-2000:]
        elif outcome == "skip":
            ET.SubElement(case, "skipped")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(suite).write(out_file, encoding="utf-8", xml_declaration=True)
    return out_file


def _json_lines(lines: Iterable[str]) -> Iterable[dict]:
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _load(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None


# --- Go ---------------------------------------------------------------


def go_json_to_junit(lines: Iterable[str], out_file: Path) -> Path | None:
    """A JUnit XML report from ``go test -json`` output, or None if no test ran."""
    results: dict[tuple[str, str], tuple[str, float, list[str]]] = {}
    output: dict[tuple[str, str], list[str]] = {}
    for event in _json_lines(lines):
        if not event.get("Test"):
            continue
        key = (str(event.get("Package", "")), str(event["Test"]))
        action = event.get("Action")
        if action == "output":
            output.setdefault(key, []).append(str(event.get("Output", "")))
        elif action in ("pass", "fail", "skip"):
            results[key] = (
                str(action),
                float(event.get("Elapsed") or 0),
                output.get(key, []),
            )
    cases = [
        (package, test, action, elapsed, "".join(out)[-2000:])
        for (package, test), (action, elapsed, out) in sorted(results.items())
    ]
    return _write(cases, "go test", out_file)


# --- Jest -------------------------------------------------------------

_JEST_OUTCOME = {"passed": "pass", "failed": "fail"}


def _relative(path: str, root: Path | None) -> str:
    if root is None or not path:
        return path
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return path


def jest_json_to_junit(
    json_file: Path, out_file: Path, root: Path | None = None
) -> Path | None:
    """JUnit from ``jest --json --outputFile``: ``file::describe > test``, like Vitest.

    A file that failed to load (syntax error, missing import) has no test of
    its own: it becomes one failed case named after the file.
    """
    data = _load(json_file)
    if not isinstance(data, dict):
        return None
    cases: list[_Case] = []
    for suite in data.get("testResults") or []:
        if not isinstance(suite, dict):
            continue
        file = _relative(
            str(suite.get("name") or suite.get("testFilePath") or ""), root
        )
        assertions = suite.get("assertionResults") or []
        if not assertions and suite.get("status") == "failed":
            cases.append((file, file, "fail", 0.0, str(suite.get("message") or "")))
            continue
        for test in assertions:
            if not isinstance(test, dict):
                continue
            title = " > ".join(
                [
                    *(str(a) for a in test.get("ancestorTitles") or []),
                    str(test.get("title", "")),
                ]
            )
            outcome = _JEST_OUTCOME.get(str(test.get("status")), "skip")
            seconds = float(test.get("duration") or 0) / 1000
            message = "\n".join(str(m) for m in test.get("failureMessages") or [])
            cases.append((file, title, outcome, seconds, message))
    return _write(cases, "jest", out_file)


# --- cargo test (libtest console output) ------------------------------

_CARGO_RUNNING = re.compile(r"^\s*Running (?:unittests )?(\S+)")
_CARGO_DOCTESTS = re.compile(r"^\s*Doc-tests (\S+)")
_CARGO_RESULT = re.compile(r"^test (.+?) \.\.\. (ok|FAILED|ignored)(?:,.*)?$")
_CARGO_STDOUT = re.compile(r"^---- (.+?) stdout ----$")


def cargo_output_to_junit(lines: Iterable[str], out_file: Path) -> Path | None:
    """JUnit from ``cargo test``'s output: ``test a::b ... ok`` per test.

    The classname is the test binary's source (``src/lib.rs``, ``tests/api.rs``)
    so two integration files with a test of the same name stay apart. The
    failure text is the ``---- name stdout ----`` block libtest prints.
    """
    binary = ""
    results: list[tuple[str, str, str]] = []
    messages: dict[tuple[str, str], list[str]] = {}
    capturing: tuple[str, str] | None = None
    for raw in lines:
        line = raw.rstrip("\n")
        running = _CARGO_RUNNING.match(line) or _CARGO_DOCTESTS.match(line)
        if running:
            binary, capturing = running.group(1), None
            continue
        result = _CARGO_RESULT.match(line)
        if result:
            # A doc test reads "src/lib.rs - add (line 3)": kept as it is.
            results.append((binary, result.group(1), result.group(2)))
            continue
        header = _CARGO_STDOUT.match(line)
        if header:
            capturing = (binary, header.group(1))
            messages[capturing] = []
            continue
        if capturing and (line == "failures:" or line.startswith("test result:")):
            capturing = None
            continue
        if capturing:
            messages[capturing].append(line)
    outcome = {"ok": "pass", "FAILED": "fail", "ignored": "skip"}
    cases = [
        (
            binary,
            name,
            outcome[status],
            0.0,
            "\n".join(messages.get((binary, name), [])).strip(),
        )
        for binary, name, status in results
    ]
    return _write(cases, "cargo test", out_file)


# --- Dart / Flutter (JSON reporter) -----------------------------------


def dart_json_to_junit(lines: Iterable[str], out_file: Path) -> Path | None:
    """JUnit from the ``json`` reporter of ``dart test`` / ``flutter test``.

    Hidden tests (``loading test/a_test.dart``) are skipped unless they fail:
    a file that does not compile fails its loading test, and that is the
    error worth showing.
    """
    suites: dict[int, str] = {}
    tests: dict[int, dict] = {}
    errors: dict[int, list[str]] = {}
    done: dict[int, dict] = {}
    for event in _json_lines(lines):
        kind = event.get("type")
        if kind == "suite" and isinstance(event.get("suite"), dict):
            suite = event["suite"]
            suites[int(suite.get("id", -1))] = str(suite.get("path") or "")
        elif kind == "testStart" and isinstance(event.get("test"), dict):
            test = event["test"]
            tests[int(test.get("id", -1))] = {**test, "_start": event.get("time", 0)}
        elif kind == "error":
            errors.setdefault(int(event.get("testID", -1)), []).append(
                str(event.get("error", ""))
            )
        elif kind == "testDone":
            done[int(event.get("testID", -1))] = event
    cases: list[_Case] = []
    for test_id, finished in sorted(done.items()):
        test = tests.get(test_id, {})
        failed = finished.get("result") in ("failure", "error")
        if finished.get("hidden") and not failed:
            continue
        if finished.get("skipped"):
            outcome = "skip"
        else:
            outcome = "fail" if failed else "pass"
        seconds = max(
            0.0,
            (float(finished.get("time") or 0) - float(test.get("_start") or 0)) / 1000,
        )
        suite = suites.get(int(test.get("suiteID", -1)), "")
        cases.append(
            (
                suite,
                str(test.get("name", "")),
                outcome,
                seconds,
                "\n".join(errors.get(test_id, [])),
            )
        )
    return _write(cases, "dart test", out_file)


# --- RSpec ------------------------------------------------------------

_RSPEC_OUTCOME = {"passed": "pass", "failed": "fail"}


def rspec_json_to_junit(json_file: Path, out_file: Path) -> Path | None:
    """JUnit from ``rspec --format json --out``: ``spec/a_spec.rb::Calc adds``."""
    data = _load(json_file)
    if not isinstance(data, dict):
        return None
    cases: list[_Case] = []
    for example in data.get("examples") or []:
        if not isinstance(example, dict):
            continue
        file = str(example.get("file_path") or "").removeprefix("./")
        exception = example.get("exception")
        message = (
            str(exception.get("message") or "") if isinstance(exception, dict) else ""
        )
        cases.append(
            (
                file,
                str(
                    example.get("full_description") or example.get("description") or ""
                ),
                _RSPEC_OUTCOME.get(str(example.get("status")), "skip"),
                float(example.get("run_time") or 0),
                message,
            )
        )
    return _write(cases, "rspec", out_file)
