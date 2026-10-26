"""Test reports, read into one shape: ``{test id: "pass" | "fail" | "skip"}``.

The judge never reads a runner's console: it asks each runner for its
machine report (JUnit XML, the Jest/Vitest JSON, a TRX file, ``go test
-json``) and reads that. A test id is built from what the report says about
the test, never from where the copy is on disk, so the same test has the same
id in every copy.

A report that cannot be read gives no test at all. The judge then counts every
expected test as not passed: a missing report is never a pass.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

PASS = "pass"
FAIL = "fail"
SKIP = "skip"

FORMATS = ("junit", "jest-json", "trx", "go-json")
# Reports beyond this are not read: no test suite of a card needs more.
MAX_REPORT_BYTES = 64 * 1024 * 1024


def _merge(results: dict[str, str], test_id: str, outcome: str) -> None:
    """A test seen twice (retries, parametrised duplicates) passes only if
    every sighting passed."""
    previous = results.get(test_id)
    if previous is None or previous == SKIP or outcome == FAIL:
        results[test_id] = outcome


def _read(path: Path) -> bytes | None:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_REPORT_BYTES:
            return None
        return path.read_bytes()
    except OSError:
        return None


def parse_junit(data: bytes) -> dict[str, str]:
    try:
        root = ElementTree.fromstring(data)
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        return {}
    results: dict[str, str] = {}
    for case in root.iter("testcase"):
        name = case.get("name") or ""
        if not name:
            continue
        classname = case.get("classname") or ""
        test_id = f"{classname}::{name}" if classname else name
        tags = {child.tag for child in case}
        if tags & {"failure", "error"}:
            outcome = FAIL
        elif "skipped" in tags:
            outcome = SKIP
        else:
            outcome = PASS
        _merge(results, test_id, outcome)
    return results


def parse_jest_json(data: bytes, root: Path) -> dict[str, str]:
    """Jest's ``--json`` and Vitest's ``json`` reporter share this shape."""
    try:
        report = json.loads(data)
    except ValueError:
        return {}
    if not isinstance(report, dict):
        return {}
    results: dict[str, str] = {}
    for suite in report.get("testResults") or []:
        if not isinstance(suite, dict):
            continue
        file_id = _relative(
            str(suite.get("name") or suite.get("testFilePath") or ""), root
        )
        for test in suite.get("assertionResults") or []:
            if not isinstance(test, dict):
                continue
            title = test.get("fullName") or test.get("title")
            if not isinstance(title, str) or not title:
                continue
            status = test.get("status")
            if status == "passed":
                outcome = PASS
            elif status in ("pending", "skipped", "todo", "disabled"):
                outcome = SKIP
            else:
                outcome = FAIL
            _merge(results, f"{file_id} > {title}", outcome)
    return results


def _relative(name: str, root: Path) -> str:
    if not name:
        return "?"
    path = Path(name)
    try:
        return PurePosixPath(path.resolve().relative_to(root.resolve())).as_posix()
    except (ValueError, OSError):
        return PurePosixPath(name.replace("\\", "/")).name


def parse_trx(data: bytes) -> dict[str, str]:
    try:
        root = ElementTree.fromstring(data)
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        return {}
    results: dict[str, str] = {}
    for element in root.iter():
        if not element.tag.endswith("UnitTestResult"):
            continue
        name = element.get("testName") or ""
        if not name:
            continue
        outcome_text = element.get("outcome") or ""
        if outcome_text == "Passed":
            outcome = PASS
        elif outcome_text in ("NotExecuted", "Inconclusive"):
            outcome = SKIP
        else:
            outcome = FAIL
        _merge(results, name, outcome)
    return results


def parse_go_json(data: bytes) -> dict[str, str]:
    results: dict[str, str] = {}
    for line in data.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        test = event.get("Test")
        action = event.get("Action")
        if not isinstance(test, str) or action not in ("pass", "fail", "skip"):
            continue
        outcome = {"pass": PASS, "fail": FAIL, "skip": SKIP}[action]
        _merge(results, f"{event.get('Package') or '?'}/{test}", outcome)
    return results


def read_report(fmt: str, path: Path, root: Path) -> dict[str, str]:
    data = _read(path)
    if data is None:
        return {}
    if fmt == "junit":
        return parse_junit(data)
    if fmt == "jest-json":
        return parse_jest_json(data, root)
    if fmt == "trx":
        return parse_trx(data)
    if fmt == "go-json":
        return parse_go_json(data)
    return {}
