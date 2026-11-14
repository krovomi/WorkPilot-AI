"""TRX, the report ``dotnet test --logger trx`` and ``vstest.console`` write.

.NET writes TRX by default, never JUnit: every reader of test reports that
knows only JUnit answers "0 tests" on a C# solution. The flaky detective and
the generational archive read TRX through these helpers, so both name a test
the same way.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET  # noqa: S405 - element types only, parsing is the caller's
from collections.abc import Iterator
from dataclasses import dataclass

__all__ = [
    "SKIPPED_OUTCOMES",
    "TrxResult",
    "duration_ms",
    "error_message",
    "full_name",
    "is_trx",
    "iter_local",
    "local_name",
    "results",
    "class_names",
]

#: Outcomes that mean "the test did not run", like a JUnit ``<skipped>``.
SKIPPED_OUTCOMES = frozenset({"notexecuted", "inconclusive", "pending", "warning"})


def local_name(tag: str) -> str:
    """The local part of a (possibly namespaced) XML tag.

    TRX declares a default namespace, so ElementTree reports
    ``{http://…/2010}UnitTestResult``: matching the local name keeps the
    reader namespace-agnostic.
    """
    return tag.rsplit("}", 1)[-1]


def iter_local(root: ET.Element, name: str) -> Iterator[ET.Element]:
    """The descendants of ``root`` whose local tag is ``name``."""
    for element in root.iter():
        if local_name(element.tag) == name:
            yield element


def is_trx(root: ET.Element) -> bool:
    return local_name(root.tag).lower() == "testrun"


def duration_ms(result: ET.Element) -> float:
    """A TRX ``duration`` (``HH:MM:SS.fffffff``) in milliseconds."""
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


def error_message(result: ET.Element) -> str:
    for message in iter_local(result, "Message"):
        if message.text:
            return message.text
    return ""


def class_names(root: ET.Element) -> dict[str, str]:
    """``testId`` → the test's class, from the TRX ``TestDefinitions``."""
    classes: dict[str, str] = {}
    for unit in iter_local(root, "UnitTest"):
        for method in iter_local(unit, "TestMethod"):
            name = method.attrib.get("className", "")
            if name:
                classes[unit.attrib.get("id", "")] = name.split(",")[0].strip()
    return classes


def full_name(result: ET.Element, classes: dict[str, str]) -> str:
    """The test's full name. MSTest writes the method alone (``Flaky``) where
    xunit writes ``Ns.Class.Flaky``: two classes with a ``Flaky`` would merge."""
    name = result.attrib.get("testName", "")
    owner = classes.get(result.attrib.get("testId", ""), "")
    if owner and not name.startswith(owner + "."):
        return f"{owner}.{name}"
    return name


@dataclass(frozen=True)
class TrxResult:
    name: str
    #: ``passed``, ``failed`` or ``skipped``.
    outcome: str
    duration_ms: float
    message: str


def results(root: ET.Element) -> list[TrxResult]:
    """Every ``UnitTestResult`` of the run, named and sorted into three outcomes."""
    classes = class_names(root)
    found: list[TrxResult] = []
    for result in iter_local(root, "UnitTestResult"):
        raw = result.attrib.get("outcome", "").lower()
        if raw in SKIPPED_OUTCOMES:
            outcome = "skipped"
        elif raw == "passed":
            outcome = "passed"
        else:
            outcome = "failed"
        found.append(
            TrxResult(
                name=full_name(result, classes),
                outcome=outcome,
                duration_ms=duration_ms(result),
                message="" if outcome != "failed" else error_message(result),
            )
        )
    return found
