"""What a generated regression test is: its framework, status and record.

Shared by ``test_generator`` (the original templates) and ``stacks`` (the
other stacks' skeletons), so that neither has to import the other's module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum

from .incident_parser import Incident


class TestFramework(str, Enum):
    PYTEST = "pytest"
    UNITTEST = "unittest"
    JEST = "jest"
    VITEST = "vitest"
    MOCHA = "mocha"
    JUNIT5 = "junit5"
    TESTNG = "testng"
    GO_TEST = "go_test"
    XUNIT = "xunit"
    NUNIT = "nunit"
    CARGO_TEST = "cargo_test"
    PHPUNIT = "phpunit"
    RSPEC = "rspec"
    DART_TEST = "dart_test"
    XCTEST = "xctest"


class TestStatus(str, Enum):
    RED = "red"
    GREEN = "green"
    SKIPPED = "skipped"


@dataclass
class GeneratedTest:
    """A regression test generated from an incident."""

    incident_id: str
    framework: TestFramework
    test_name: str
    test_code: str
    file_path: str
    status: TestStatus = TestStatus.RED
    target_file: str = ""
    target_function: str = ""
    fixtures: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


def safe_function_name(incident: Incident) -> str:
    """Derive a safe function name from the incident."""
    base = incident.faulting_function or incident.exception_type or incident.id
    safe = re.sub(r"[^a-zA-Z0-9]", "_", base).strip("_").lower()
    return safe[:60] or "unknown"
