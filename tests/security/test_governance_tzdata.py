"""IANA zone names in workpilot.policy.yaml on a machine without zone data (#353, lot 4).

Windows, and the Python the desktop app embeds there, have no system time zone
database: ``ZoneInfo("Europe/Paris")`` only works there through the ``tzdata``
package. Without it, a policy that names its zone was refused on Windows and
accepted on Linux and macOS, so the same file meant two things to one team.
These tests keep the package a declared, locked, unconditional dependency, and
show that the policy reads a zone name with no system database at all.
"""

from __future__ import annotations

import re
import zoneinfo
from datetime import UTC, datetime
from pathlib import Path

import pytest
from security.governance_policy import parse_governance

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


def _requirement_lines() -> list[str]:
    text = (BACKEND / "requirements.txt").read_text(encoding="utf-8")
    return [line.split("#", 1)[0].strip() for line in text.splitlines()]


def test_tzdata_is_required_on_every_platform():
    lines = [line for line in _requirement_lines() if line.startswith("tzdata")]
    assert len(lines) == 1
    # No environment marker: Linux and macOS servers need it too when their
    # image has no /usr/share/zoneinfo (slim containers).
    assert ";" not in lines[0]


def test_tzdata_is_pinned_with_hashes_in_the_lock():
    lock = (BACKEND / "requirements.lock").read_text(encoding="utf-8")
    match = re.search(
        r"^tzdata==(\S+) \\\n((?:\s+--hash=sha256:[0-9a-f]{64}.*\n)+)", lock, re.M
    )
    assert match, "tzdata must be pinned with its hashes in requirements.lock"


@pytest.fixture
def no_system_zones():
    """The machine of a Windows user: no zone database but the package."""
    zoneinfo.reset_tzpath(to=[])
    zoneinfo.ZoneInfo.clear_cache()
    try:
        yield
    finally:
        zoneinfo.reset_tzpath()
        zoneinfo.ZoneInfo.clear_cache()


def test_a_zone_name_is_read_without_a_system_database(no_system_zones):
    governance, errors = parse_governance(
        {"schedule": {"timezone": "Europe/Paris", "allowed_hours": ["08:00-19:00"]}},
        "workpilot.policy.yaml",
    )
    assert errors == []
    assert governance.timezone == "Europe/Paris"
    # Paris is UTC+1 in January: 07:30 UTC is 08:30 there, inside the window.
    assert governance.is_open(datetime(2027, 1, 4, 7, 30, tzinfo=UTC))
    assert not governance.is_open(datetime(2027, 1, 4, 6, 30, tzinfo=UTC))
