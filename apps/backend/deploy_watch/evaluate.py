"""Is the deployment worse than what ran before it? Pure (#366).

Each metric of a sample is compared to its baseline, the value measured
before the deployment landed: the change in percent, counted in the
direction that hurts (up for errors and latency, down for throughput). A
change smaller than the metric's `min_absolute` is noise. From a zero
baseline any real change is critical: an error rate going from 0 to 2 % has
no percentage, and it is the case the watch exists for.

A failed health check is critical. One critical sample is a warning: a
traffic spike right after a rollout must not undo it; two in a row are the
critical verdict.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from .config import MetricRule, Worse
from .net import HealthResult

CRITICAL_IN_A_ROW = 2


class Level(StrEnum):
    OK = "ok"
    WARNING = "warning"
    CRITICAL = "critical"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class MetricCheck:
    name: str
    kind: str
    baseline: float | None
    current: float | None
    change_pct: float | None
    level: Level

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "baseline": self.baseline,
            "current": self.current,
            "change_pct": self.change_pct,
            "level": self.level.value,
        }


def compare(
    rule: MetricRule, baseline: float | None, current: float | None
) -> MetricCheck:
    def check(change: float | None, level: Level) -> MetricCheck:
        return MetricCheck(rule.name, rule.kind.value, baseline, current, change, level)

    if baseline is None or current is None:
        return check(None, Level.UNKNOWN)
    worse_by = current - baseline if rule.worse is Worse.UP else baseline - current
    if worse_by <= rule.min_absolute or worse_by <= 0:
        change = None if baseline == 0 else round(100 * worse_by / abs(baseline), 2)
        return check(change, Level.OK)
    if baseline == 0:
        return check(None, Level.CRITICAL)
    change = round(100 * worse_by / abs(baseline), 2)
    if change >= rule.critical_pct:
        return check(change, Level.CRITICAL)
    if change >= rule.warning_pct:
        return check(change, Level.WARNING)
    return check(change, Level.OK)


def sample_level(checks: Sequence[MetricCheck], health: HealthResult | None) -> Level:
    levels = [c.level for c in checks]
    if health is not None and not health.ok:
        return Level.CRITICAL
    if Level.CRITICAL in levels:
        return Level.CRITICAL
    if Level.WARNING in levels:
        return Level.WARNING
    if health is not None or Level.OK in levels:
        return Level.OK
    return Level.UNKNOWN


def verdict(levels: Sequence[Level]) -> Level:
    """The watch's verdict from its samples so far, oldest first."""
    run = 0
    for level in levels:
        run = run + 1 if level is Level.CRITICAL else 0
        if run >= CRITICAL_IN_A_ROW:
            return Level.CRITICAL
    if any(level in (Level.CRITICAL, Level.WARNING) for level in levels):
        return Level.WARNING
    if Level.OK in levels:
        return Level.OK
    return Level.UNKNOWN
