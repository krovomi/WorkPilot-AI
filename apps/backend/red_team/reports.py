"""What each attack test did, read from the runner's machine report.

JUnit XML (pytest, Vitest, Jest with ``jest-junit``, Maven, Gradle, and Go
through ``suite_runner``) and TRX (.NET) carry one entry per test with
its failure text. The console of a runner without such a report is read only
for cargo's ``test name ... FAILED`` lines; elsewhere the attack's file is run
alone and its exit code speaks for it (``engine``).

A failure is a **crash** only when an exception that marks a programming error
(``TypeError``, ``NullReferenceException``, ``panic:``…) escaped *and* its
stack trace names a source file the task changed. A test that calls the code
wrongly raises in the test file only: that is a broken attack, never a crash
of the code under attack. Every other failure is **unexpected**: the code
answered, but not what the attack expected, which may be the attack's fault —
so it is shown, never blocking.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

__all__ = [
    "CRASH",
    "RESISTANT",
    "UNEXPECTED",
    "TestResult",
    "classify",
    "find_result",
    "normalise",
    "parse_cargo_output",
    "read_reports",
]

RESISTANT = "resistant"
UNEXPECTED = "unexpected"
CRASH = "crash"

MAX_REPORT_BYTES = 32 * 1024 * 1024
MAX_MESSAGE_CHARS = 4000

# Exceptions that say the code did not handle the input, never that it
# rejected it on purpose. ArgumentException, ValueError, IllegalArgument… are
# how a function refuses bad input and are left out.
_CRASH_MARKERS = re.compile(
    r"\b(?:"
    # Python
    r"TypeError|KeyError|IndexError|AttributeError|ZeroDivisionError|RecursionError"
    r"|UnboundLocalError|NameError|OverflowError|UnicodeDecodeError|UnicodeEncodeError"
    # .NET
    r"|NullReferenceException|IndexOutOfRangeException|InvalidCastException"
    r"|KeyNotFoundException|DivideByZeroException|StackOverflowException"
    r"|OverflowException|FormatException|InvalidOperationException"
    # JavaScript / TypeScript
    r"|RangeError|ReferenceError|Maximum call stack size exceeded"
    # JVM
    r"|NullPointerException|ArrayIndexOutOfBoundsException|StringIndexOutOfBoundsException"
    r"|IndexOutOfBoundsException|ClassCastException|ArithmeticException"
    r"|NumberFormatException|StackOverflowError|ConcurrentModificationException"
    r"|NoSuchElementException"
    # Ruby, PHP, Elixir, Dart, Swift
    r"|NoMethodError|FrozenError|DivisionByZeroError|FunctionClauseError|MatchError"
    r"|CaseClauseError|NoSuchMethodError|Null check operator used on a null value"
    r"|Unexpectedly found nil|Index out of range"
    r")\b"
    # Go, Rust
    r"|panic: |runtime error: |panicked at"
)
_ASSERTION = re.compile(
    r"assertion (?:`[^`]*` )?failed|AssertionError|assert_eq|assert_ne", re.IGNORECASE
)


@dataclass(frozen=True)
class TestResult:
    """One test case of a report."""

    __test__ = False  # not a pytest class

    name: str
    passed: bool
    message: str = ""


def normalise(name: str) -> str:
    """``test_red_team_empty[x]``, ``RedTeam_Empty`` → comparable lower text."""
    name = re.sub(r"\[.*\]$|\(.*\)$", "", name.strip())
    return re.sub(r"[\s_\-`'\".:>/]+", "", name).lower()


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _read(path: Path) -> bytes | None:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_REPORT_BYTES:
            return None
        return path.read_bytes()
    except OSError:
        return None


def _junit(root) -> list[TestResult]:
    results = []
    for case in root.iter():
        if _local(case.tag) != "testcase":
            continue
        name = str(case.get("name") or "")
        klass = str(case.get("classname") or "")
        message = ""
        failed = False
        skipped = False
        for child in case:
            kind = _local(child.tag)
            if kind in ("failure", "error"):
                failed = True
                message += " ".join(
                    s
                    for s in (child.get("message"), child.get("type"), child.text)
                    if s
                )
            elif kind == "skipped":
                skipped = True
        if skipped and not failed:
            continue
        full = f"{klass}.{name}" if klass and klass not in name else name
        results.append(TestResult(full, not failed, message[:MAX_MESSAGE_CHARS]))
    return results


def _trx(root) -> list[TestResult]:
    results = []
    for node in root.iter():
        if _local(node.tag) != "UnitTestResult":
            continue
        outcome = str(node.get("outcome") or "")
        if outcome not in ("Passed", "Failed", "Error", "Timeout"):
            continue
        message = " ".join(
            (child.text or "")
            for child in node.iter()
            if _local(child.tag) in ("Message", "StackTrace", "StdOut")
        )
        results.append(
            TestResult(
                str(node.get("testName") or ""),
                outcome == "Passed",
                message[:MAX_MESSAGE_CHARS],
            )
        )
    return results


def read_reports(paths: list[Path]) -> list[TestResult]:
    """Every test case of the JUnit and TRX files given. Unreadable ones give none."""
    results: list[TestResult] = []
    for path in paths:
        data = _read(path)
        if data is None:
            continue
        try:
            root = ElementTree.fromstring(data)
        except (ElementTree.ParseError, DefusedXmlException):
            continue
        results += _trx(root) if _local(root.tag) == "TestRun" else _junit(root)
    return results


_CARGO_LINE = re.compile(r"^test (\S+) \.\.\. (ok|FAILED)$", re.MULTILINE)
_CARGO_PANIC = re.compile(r"^---- (\S+) stdout ----$(.*?)(?=^---- |\Z)", re.M | re.S)


def parse_cargo_output(output: str) -> list[TestResult]:
    """cargo test's console: ``test x ... FAILED`` and the panic block of each."""
    panics = {m.group(1): m.group(2) for m in _CARGO_PANIC.finditer(output)}
    return [
        TestResult(name, status == "ok", panics.get(name, "")[:MAX_MESSAGE_CHARS])
        for name, status in _CARGO_LINE.findall(output)
    ]


def find_result(test: str, results: list[TestResult]) -> TestResult | None:
    """The report entry of the attack test called ``test``; failures win."""
    wanted = normalise(test)
    if not wanted:
        return None
    found = [r for r in results if normalise(r.name).endswith(wanted)]
    if not found:
        return None
    failed = [r for r in found if not r.passed]
    return failed[0] if failed else found[0]


def _names_a_source(message: str, sources: list[str]) -> bool:
    for source in sources:
        base = PurePosixPath(source).name
        if base and re.search(rf"(?:^|[\\/(\s\"'@]){re.escape(base)}\b", message):
            return True
    return False


def classify(result: TestResult, sources: list[str]) -> str:
    """``resistant``, ``crash`` (a programming error inside the changed code) or ``unexpected``."""
    if result.passed:
        return RESISTANT
    message = result.message
    if (
        _CRASH_MARKERS.search(message)
        and not (_ASSERTION.search(message) and "panicked at" in message)
        and _names_a_source(message, sources)
    ):
        return CRASH
    return UNEXPECTED
