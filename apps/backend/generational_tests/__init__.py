"""Generational Test Archive.

Snapshots a test run as a generation, then compares future runs against
that snapshot to surface regressions:
  * tests that were passing and now fail
  * tests that got significantly slower
  * tests that disappeared (deleted? renamed?)
  * brand-new tests that didn't exist in the baseline

Different from `flaky_test_detective/` which looks for *intermittent*
failures across many runs of the same revision. This module looks for
*regression* between revisions.

Any stack's report: JUnit XML, TRX (.NET), Jest/Vitest JSON, ``go test
-json``, ``cargo test`` output, Dart/Flutter JSON and RSpec JSON
(``reports.parse_report``, format read from the content). The runner
``runners/generational_tests_runner.py`` runs the project's own suite to
capture or compare without a report at hand.
"""

from .archive import (
    Generation,
    GenerationalArchive,
    RegressionReport,
    TestOutcome,
    TestStatus,
    parse_junit_xml,
)
from .reports import ReportError, parse_report, parse_report_file

__all__ = [
    "GenerationalArchive",
    "Generation",
    "RegressionReport",
    "TestOutcome",
    "TestStatus",
    "ReportError",
    "parse_junit_xml",
    "parse_report",
    "parse_report_file",
]
