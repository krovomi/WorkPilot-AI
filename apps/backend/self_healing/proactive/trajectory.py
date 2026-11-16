"""Where a file's risk is going, from its snapshots (#370).

Deterministic and local: a least-squares slope (risk points per week) over
the last :data:`WINDOW_DAYS`, the change of that slope between the older and
the newer half of the window, and four classes the person reads at a glance —

``stable``      little movement, high or low
``slow_rise``   a moderate positive slope
``fast_rise``   a steep one: the hot list
``improving``   a negative one (the refactor pays)

and ``new`` for a file with fewer than :data:`MIN_POINTS` snapshots, which is
neutral until it has a history. A single drop of :data:`RESET_DROP` points or
more is a rewrite: the history before it describes another file, so the
trajectory starts again from there (``reset``).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import Enum
from typing import Any

__all__ = [
    "FAST_SLOPE",
    "MIN_POINTS",
    "RESET_DROP",
    "SLOW_SLOPE",
    "WINDOW_DAYS",
    "FileTrend",
    "Point",
    "Trajectory",
    "classify",
]

MIN_POINTS = 4
WINDOW_DAYS = 90
#: Risk points per week.
SLOW_SLOPE = 1.0
FAST_SLOPE = 4.0
#: Smallest change over the window that is not noise.
MIN_RISE = 3.0
#: A fast rise also moved the risk this much.
MIN_FAST_RISE = 10.0
RESET_DROP = 30.0


class Trajectory(str, Enum):
    NEW = "new"
    STABLE = "stable"
    SLOW_RISE = "slow_rise"
    FAST_RISE = "fast_rise"
    IMPROVING = "improving"


@dataclass(frozen=True)
class Point:
    day: date
    risk: float
    complexity: float = 0.0
    churn: int = 0
    coverage: float = 0.0


@dataclass
class FileTrend:
    file: str
    trajectory: Trajectory
    #: Risk points per week over the window.
    slope: float = 0.0
    #: Newer half's slope minus the older half's, per week.
    acceleration: float = 0.0
    risk: float = 0.0
    #: Risk at the start of the window (after a reset, at the reset).
    start_risk: float = 0.0
    reset: bool = False
    #: The last snapshot moved the file into ``fast_rise``.
    entered_hot: bool = False
    #: Facts for the "why": complexity change in percent, churn then and now.
    complexity_change_pct: float = 0.0
    churn_start: int = 0
    churn_now: int = 0
    points: list[Point] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "trajectory": self.trajectory.value,
            "slope": round(self.slope, 2),
            "acceleration": round(self.acceleration, 2),
            "risk": round(self.risk, 1),
            "start_risk": round(self.start_risk, 1),
            "reset": self.reset,
            "entered_hot": self.entered_hot,
            "complexity_change_pct": round(self.complexity_change_pct, 1),
            "churn_start": self.churn_start,
            "churn_now": self.churn_now,
            "points": [
                {"day": p.day.isoformat(), "risk": round(p.risk, 1)}
                for p in self.points
            ],
        }


def _slope_per_week(points: Sequence[Point]) -> float:
    origin = points[0].day
    xs = [(p.day - origin).days for p in points]
    ys = [p.risk for p in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    var = sum((x - mean_x) ** 2 for x in xs)
    if var == 0:
        return 0.0
    cov = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True))
    return cov / var * 7.0


def _window(points: Sequence[Point], window_days: int) -> tuple[list[Point], bool]:
    ordered = sorted(points, key=lambda p: p.day)
    if not ordered:
        return [], False
    since = ordered[-1].day - timedelta(days=window_days)
    kept = [p for p in ordered if p.day >= since]
    reset = False
    for index in range(len(kept) - 1, 0, -1):
        if kept[index - 1].risk - kept[index].risk >= RESET_DROP:
            kept, reset = kept[index:], True
            break
    return kept, reset


def _class_of(points: Sequence[Point]) -> tuple[Trajectory, float, float]:
    if len(points) < MIN_POINTS:
        return Trajectory.NEW, 0.0, 0.0
    slope = _slope_per_week(points)
    half = len(points) // 2
    older, newer = points[: half + 1], points[half:]
    acceleration = 0.0
    span_weeks = (points[-1].day - points[0].day).days / 7.0
    if span_weeks > 0:
        acceleration = (_slope_per_week(newer) - _slope_per_week(older)) / (
            span_weeks / 2.0
        )
    change = points[-1].risk - points[0].risk
    recent = _slope_per_week(newer)
    if (slope >= FAST_SLOPE or (recent >= FAST_SLOPE and slope >= SLOW_SLOPE)) and (
        change >= MIN_FAST_RISE
    ):
        return Trajectory.FAST_RISE, slope, acceleration
    if slope >= SLOW_SLOPE and change >= MIN_RISE:
        return Trajectory.SLOW_RISE, slope, acceleration
    if slope <= -SLOW_SLOPE and change <= -MIN_RISE:
        return Trajectory.IMPROVING, slope, acceleration
    return Trajectory.STABLE, slope, acceleration


def classify(
    file: str, points: Sequence[Point], window_days: int = WINDOW_DAYS
) -> FileTrend:
    """The trajectory of one file's risk."""
    kept, reset = _window(points, window_days)
    if not kept:
        return FileTrend(file=file, trajectory=Trajectory.NEW)
    trajectory, slope, acceleration = _class_of(kept)
    previous, _s, _a = _class_of(kept[:-1])
    first, last = kept[0], kept[-1]
    base = max(first.complexity, 1.0)
    return FileTrend(
        file=file,
        trajectory=trajectory,
        slope=slope,
        acceleration=acceleration,
        risk=last.risk,
        start_risk=first.risk,
        reset=reset,
        entered_hot=trajectory is Trajectory.FAST_RISE
        and previous is not Trajectory.FAST_RISE,
        complexity_change_pct=(last.complexity - first.complexity) / base * 100.0,
        churn_start=first.churn,
        churn_now=last.churn,
        points=kept,
    )
