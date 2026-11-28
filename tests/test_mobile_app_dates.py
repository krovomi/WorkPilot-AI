"""The phone app writes dates in the app's language, not the phone's region.

Same rule as the desktop (``apps/frontend/src/renderer/lib/__tests__/date-format.test.ts``):
French writes 28/11/2026, English 11/28/2026, whatever the phone is set to.
Every date in ``apps/mobile/src`` goes through ``ui/format.ts`` (``formatDate``,
``formatDay``, ``dateLocale``); a native date picker, which follows the phone's
region, is refused too.
"""

from __future__ import annotations

import re
from pathlib import Path

MOBILE_SRC = Path(__file__).resolve().parents[1] / "apps" / "mobile" / "src"

FORBIDDEN = {
    "toLocaleDateString/TimeString without dateLocale": re.compile(
        r"\.toLocale(?:Date|Time)String\((?!\s*dateLocale\()"
    ),
    "new Date(...).toLocaleString without dateLocale": re.compile(
        r"new Date\([^;]*?\)\s*\.toLocaleString\((?!\s*dateLocale\()"
    ),
    "a native date picker": re.compile(r"datetimepicker|DateTimePicker"),
}


def _sources() -> list[Path]:
    return [
        path
        for path in MOBILE_SRC.rglob("*")
        if path.suffix in {".ts", ".tsx"}
        and "__tests__" not in path.parts
        and ".test." not in path.name
    ]


def test_every_mobile_date_goes_through_ui_format():
    offenders = [
        f"{path.relative_to(MOBILE_SRC)}: {name}"
        for path in _sources()
        for name, pattern in FORBIDDEN.items()
        if pattern.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_the_guard_would_catch_one():
    assert FORBIDDEN["toLocaleDateString/TimeString without dateLocale"].search(
        "d.toLocaleDateString()"
    )
    assert not FORBIDDEN["toLocaleDateString/TimeString without dateLocale"].search(
        "d.toLocaleDateString(dateLocale(lang))"
    )
    assert FORBIDDEN["new Date(...).toLocaleString without dateLocale"].search(
        'new Date(iso).toLocaleString("en-GB")'
    )
    assert FORBIDDEN["a native date picker"].search(
        'import DateTimePicker from "@react-native-community/datetimepicker"'
    )
    assert _sources()
