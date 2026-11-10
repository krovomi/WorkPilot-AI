"""A framework's controls judged against the dated evidence of a period (#357).

Each control is **covered** (every requirement met by evidence young enough at
the end of the period), **failing** (a requirement met only by failed checks:
a rejected review, a failed test, a blocked dependency), **stale** (evidence,
but older than the control allows) or **missing** (none at all). A control is
**alerted** when nothing has evidenced it for more than 30 days.

The report carries the mapping it was judged with (the controls and what they
needed), so that a report saved before a framework changed still reads as it
was written, and an executive summary and the recommendations of every gap
computed from the evidence, without a model.
"""

from __future__ import annotations

import calendar
import re
from datetime import UTC, datetime
from typing import Any

from .evidence import DAY, Evidence
from .frameworks import Control, Framework

__all__ = [
    "ALERT_DAYS",
    "REPORT_VERSION",
    "build_report",
    "month_period",
    "period_of",
]

REPORT_VERSION = 1
ALERT_DAYS = 30
#: Per control, the items listed in the report (all are counted).
MAX_LISTED = 25
_MONTH = re.compile(r"^(\d{4})-(\d{2})$")


def month_period(label: str) -> tuple[float, float]:
    """``2026-10`` -> the first and last second of October 2026, UTC."""
    match = _MONTH.match(label or "")
    if not match or not 1 <= int(match[2]) <= 12 or not 2000 <= int(match[1]) <= 2999:
        raise ValueError(f"not a month: {label!s:.20}")
    year, month = int(match[1]), int(match[2])
    start = datetime(year, month, 1, tzinfo=UTC).timestamp()
    last = calendar.monthrange(year, month)[1]
    end = datetime(year, month, last, 23, 59, 59, tzinfo=UTC).timestamp()
    return start, end


def period_of(at: float) -> str:
    return datetime.fromtimestamp(at, tz=UTC).strftime("%Y-%m")


def _iso(at: float | None) -> str | None:
    if at is None:
        return None
    return datetime.fromtimestamp(at, tz=UTC).isoformat(timespec="seconds")


def _requirement(
    kinds: tuple[str, ...], items: list[Evidence], until: float, max_age: int
) -> dict[str, Any]:
    """One requirement of a control: its latest evidence and its verdict."""
    matching = [e for e in items if e.kind in kinds]
    fresh = [e for e in matching if (until - e.at) <= max_age * DAY]
    latest = matching[0].at if matching else None
    if not matching:
        status = "missing"
    elif not fresh:
        status = "stale"
    elif all(e.outcome == "fail" for e in fresh):
        status = "failing"
    else:
        status = "covered"
    return {
        "kinds": list(kinds),
        "status": status,
        "lastEvidenceAt": _iso(latest),
        "ageDays": None if latest is None else max(0, int((until - latest) // DAY)),
        "count": len(fresh),
    }


_WORST = ("missing", "failing", "stale", "covered")


def _control(
    control: Control, items: list[Evidence], since: float, until: float
) -> dict[str, Any]:
    requirements = [
        _requirement(kinds, items, until, control.max_age_days)
        for kinds in control.requirements
    ]
    status = min((r["status"] for r in requirements), key=_WORST.index)
    kinds = {k for group in control.requirements for k in group}
    relevant = [e for e in items if e.kind in kinds]
    in_period = [e for e in relevant if e.at >= since]
    listed = in_period[:MAX_LISTED] or relevant[:1]
    latest = relevant[0].at if relevant else None
    age = None if latest is None else max(0, int((until - latest) // DAY))
    return {
        **control.to_dict(),
        "status": status,
        "checks": requirements,
        "lastEvidenceAt": _iso(latest),
        "ageDays": age,
        "alert": age is None or age > ALERT_DAYS,
        "periodCount": len(in_period),
        "failures": sum(1 for e in in_period if e.outcome == "fail"),
        "evidence": [e.to_dict() for e in listed],
    }


def build_report(
    framework: Framework,
    evidence: list[Evidence],
    since: float,
    until: float,
    *,
    now: float | None = None,
    period: str = "",
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    """The report of ``framework`` for the period from ``since`` to ``until``."""
    items = sorted(
        (e for e in evidence if e.at <= until), key=lambda e: e.at, reverse=True
    )
    controls = [_control(c, items, since, until) for c in framework.controls]
    counts = {s: sum(1 for c in controls if c["status"] == s) for s in _WORST}
    total = len(controls)
    in_period = [e for e in items if e.at >= since]
    by_kind: dict[str, int] = {}
    for item in in_period:
        by_kind[item.kind] = by_kind.get(item.kind, 0) + 1
    gaps = [
        {
            "controlId": c["id"],
            "title": c["title"],
            "status": c["status"],
            "ageDays": c["ageDays"],
            "alert": c["alert"],
            "missingKinds": sorted(
                {k for r in c["checks"] if r["status"] != "covered" for k in r["kinds"]}
            ),
            "recommendation": c["recommendation"],
        }
        for c in controls
        if c["status"] != "covered"
    ]
    approvals = sum(1 for e in in_period if e.kind == "spec_approval")
    reviews = [e for e in in_period if e.kind == "code_review"]
    tests = [e for e in in_period if e.kind == "tests"]
    security = [e for e in in_period if e.kind == "security"]
    return {
        "version": REPORT_VERSION,
        "framework": framework.summary(),
        "period": {
            "label": period or period_of(until),
            "start": _iso(since),
            "end": _iso(until),
        },
        "generatedAt": _iso(now if now is not None else datetime.now(UTC).timestamp()),
        "coveragePercent": round(100 * counts["covered"] / total, 1) if total else 0.0,
        "summary": {
            "controls": total,
            **counts,
            "alerts": sum(1 for c in controls if c["alert"]),
            "evidence": len(in_period),
            "byKind": dict(sorted(by_kind.items())),
            "specApprovals": approvals,
            "reviewsApproved": sum(1 for e in reviews if e.outcome == "pass"),
            "reviewsRejected": sum(1 for e in reviews if e.outcome == "fail"),
            "testsPassed": sum(1 for e in tests if e.outcome == "pass"),
            "testsFailed": sum(1 for e in tests if e.outcome == "fail"),
            "securityFindings": sum(1 for e in security if e.outcome == "fail"),
            "tasks": len({e.task for e in in_period if e.task}),
        },
        "risks": [
            g["controlId"] for g in gaps if g["status"] in ("missing", "failing")
        ],
        "gaps": gaps,
        "controls": controls,
        "warnings": list(warnings or []),
    }
