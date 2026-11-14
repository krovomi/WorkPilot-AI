"""Read a test report of any stack into the archive's outcomes.

A generation used to come from JUnit XML only, so a .NET solution (TRX by
default), a Go module (``go test -json``), a Jest or Vitest suite (``--json``),
a Rust crate (``cargo test``'s console output), a Dart/Flutter package (the
``json`` reporter) or a Ruby project (``rspec --format json``) had nothing to
capture unless its owner installed a JUnit reporter first.

The format is read from the content, never from a file name: the person may
paste a report as well as import a file. The JUnit writers of
``suite_runner.converters`` and the TRX reader of ``suite_runner.trx`` are the
ones the flaky detective uses, so both features name a test the same way.
"""

from __future__ import annotations

import json
import re
import tempfile
import xml.etree.ElementTree as ET  # noqa: S405 - element/ParseError types only
from collections.abc import Callable
from pathlib import Path

from defusedxml.ElementTree import fromstring as defused_fromstring
from suite_runner import trx
from suite_runner.converters import (
    cargo_output_to_junit,
    dart_json_to_junit,
    go_json_to_junit,
    jest_json_to_junit,
    rspec_json_to_junit,
)

from .archive import TestOutcome, TestStatus, parse_junit_root

__all__ = ["FORMATS", "MAX_REPORT_CHARS", "parse_report", "parse_report_file"]

#: The formats a report can be in, as the UI names them.
FORMATS = ("junit", "trx", "jest", "go", "cargo", "dart", "rspec")

#: Larger than any suite's report seen so far; the UI refuses more.
MAX_REPORT_CHARS = 5_000_000

_TRX_STATUS = {
    "passed": TestStatus.PASSED,
    "failed": TestStatus.FAILED,
    "skipped": TestStatus.SKIPPED,
}


#: A line of libtest's output: ``test a::b ... ok``.
_CARGO_LINE = re.compile(r"^test \S.* \.\.\. (ok|FAILED|ignored)\b", re.MULTILINE)


class ReportError(ValueError):
    """The text is not a report of a known format; ``code`` says why."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _split_trx_name(full: str) -> tuple[str, str]:
    """``Shop.Tests.CartTests.Adds(qty: 2)`` → (``Shop.Tests.CartTests``, ``Adds(qty: 2)``).

    The parameters stay: two cases of one theory are two tests of a generation.
    """
    head = full.split("(", 1)[0]
    if "." not in head:
        return "", full
    owner = head.rpartition(".")[0]
    return owner, full[len(owner) + 1 :]


def _trx_outcomes(root: ET.Element) -> list[TestOutcome]:
    outcomes: list[TestOutcome] = []
    for result in trx.results(root):
        classname, name = _split_trx_name(result.name)
        outcomes.append(
            TestOutcome(
                test_id=f"{classname}::{name}" if classname else name,
                name=name,
                classname=classname,
                status=_TRX_STATUS[result.outcome],
                duration_seconds=result.duration_ms / 1000,
                failure_message=result.message[:500],
            )
        )
    return outcomes


def _xml_outcomes(text: str) -> tuple[str, list[TestOutcome]]:
    try:
        root = defused_fromstring(text)
    except ET.ParseError as exc:
        raise ReportError("invalid_xml", str(exc)) from exc
    if trx.is_trx(root):
        return "trx", _trx_outcomes(root)
    if root.tag not in ("testsuites", "testsuite"):
        raise ReportError("unknown_format", root.tag)
    return "junit", parse_junit_root(root)


def _converted(
    write: Callable[[Path, Path], Path | None],
) -> list[TestOutcome]:
    """Run a ``suite_runner`` converter in a scratch folder and read its JUnit."""
    with tempfile.TemporaryDirectory(prefix="workpilot-gen-") as scratch:
        folder = Path(scratch)
        written = write(folder / "report.in", folder / "report.xml")
        if written is None:
            return []
        return parse_junit_root(defused_fromstring(written.read_bytes()))


def _from_file(
    text: str, convert: Callable[..., Path | None], **options: object
) -> list[TestOutcome]:
    def write(source: Path, out: Path) -> Path | None:
        source.write_text(text, encoding="utf-8")
        return convert(source, out, **options)

    return _converted(write)


def _from_lines(text: str, convert: Callable[..., Path | None]) -> list[TestOutcome]:
    return _converted(lambda _source, out: convert(text.splitlines(), out))


def _json_document(text: str) -> object:
    try:
        return json.loads(text)
    except ValueError:
        return None


def _first_json_line(text: str) -> dict | None:
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            return None
        return event if isinstance(event, dict) else None
    return None


def parse_report(text: str, root: Path | None = None) -> tuple[str, list[TestOutcome]]:
    """``(format, outcomes)`` of a report, whatever stack wrote it.

    ``root`` is the project: Jest and Vitest name each file by its absolute
    path, which would make every test of a run elsewhere look new.

    Raises ``ReportError`` (a ``ValueError``) with a code the UI translates:
    ``empty``, ``too_large``, ``invalid_xml``, ``unknown_format`` or
    ``no_tests`` (a report of a known format that holds no test).
    """
    if not text.strip():
        raise ReportError("empty")
    if len(text) > MAX_REPORT_CHARS:
        raise ReportError("too_large")
    stripped = text.lstrip("﻿").strip()

    found: tuple[str, list[TestOutcome]] | None = None
    if stripped.startswith("<"):
        found = _xml_outcomes(stripped)
    else:
        document = _json_document(stripped)
        if isinstance(document, dict) and "testResults" in document:
            found = "jest", _from_file(stripped, jest_json_to_junit, root=root)
        elif isinstance(document, dict) and "examples" in document:
            found = "rspec", _from_file(stripped, rspec_json_to_junit)
        else:
            event = _first_json_line(stripped)
            if event is not None and "Action" in event:
                found = "go", _from_lines(stripped, go_json_to_junit)
            elif event is not None and "type" in event and "time" in event:
                found = "dart", _from_lines(stripped, dart_json_to_junit)
            elif _CARGO_LINE.search(stripped):
                found = "cargo", _from_lines(stripped, cargo_output_to_junit)
    if found is None:
        raise ReportError("unknown_format")
    if not found[1]:
        raise ReportError("no_tests", found[0])
    return found


def parse_report_file(
    path: Path, root: Path | None = None
) -> tuple[str, list[TestOutcome]]:
    """``parse_report`` of a report on disk (a run's TRX or JUnit)."""
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ReportError("unreadable", path.name) from exc
    if size > MAX_REPORT_CHARS:
        raise ReportError("too_large")
    return parse_report(path.read_text(encoding="utf-8", errors="replace"), root)
