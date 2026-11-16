"""The hot list and the directories that degrade together (#370).

A file rising on its own is a file; half a directory rising is a module
going bad. A cluster is a directory where at least :data:`MIN_CLUSTER_FILES`
of the files with a history are rising (slowly or fast) and they are at least
:data:`MIN_CLUSTER_SHARE` of them. Directories are compared as written in the
repository (``/`` separators), so any language, any layout.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from posixpath import dirname
from typing import Any

from .trajectory import WINDOW_DAYS, FileTrend, Point, Trajectory, classify

__all__ = [
    "HOT_LIMIT",
    "MIN_CLUSTER_FILES",
    "MIN_CLUSTER_SHARE",
    "build_trend_report",
    "degrading_clusters",
]

HOT_LIMIT = 20
MAX_CLUSTERS = 10
MIN_CLUSTER_FILES = 2
MIN_CLUSTER_SHARE = 0.5

_RISING = (Trajectory.FAST_RISE, Trajectory.SLOW_RISE)


def degrading_clusters(trends: Sequence[FileTrend]) -> list[dict[str, Any]]:
    """Directories whose files rise together, the most affected first."""
    by_dir: dict[str, list[FileTrend]] = {}
    for trend in trends:
        if trend.trajectory is Trajectory.NEW:
            continue
        by_dir.setdefault(dirname(trend.file) or ".", []).append(trend)
    clusters: list[dict[str, Any]] = []
    for directory, members in by_dir.items():
        rising = [t for t in members if t.trajectory in _RISING]
        if len(rising) < MIN_CLUSTER_FILES:
            continue
        share = len(rising) / len(members)
        if share < MIN_CLUSTER_SHARE:
            continue
        rising.sort(key=lambda t: t.slope, reverse=True)
        clusters.append(
            {
                "directory": directory,
                "files": [t.file for t in rising],
                "rising": len(rising),
                "fast": sum(1 for t in rising if t.trajectory is Trajectory.FAST_RISE),
                "total": len(members),
                "share": round(share, 2),
                "mean_slope": round(sum(t.slope for t in rising) / len(rising), 2),
            }
        )
    clusters.sort(key=lambda c: (c["fast"], c["rising"], c["mean_slope"]), reverse=True)
    return clusters[:MAX_CLUSTERS]


def build_trend_report(
    series: Mapping[str, Sequence[Point]],
    *,
    snapshots: int = 0,
    window_days: int = WINDOW_DAYS,
    hot_limit: int = HOT_LIMIT,
) -> dict[str, Any]:
    """What the proactive view shows: counts, hot list, rising list, clusters."""
    trends = [classify(f, pts, window_days) for f, pts in series.items()]
    counts = {t.value: 0 for t in Trajectory}
    for trend in trends:
        counts[trend.trajectory.value] += 1
    fast = sorted(
        (t for t in trends if t.trajectory is Trajectory.FAST_RISE),
        key=lambda t: t.slope,
        reverse=True,
    )
    slow = sorted(
        (t for t in trends if t.trajectory is Trajectory.SLOW_RISE),
        key=lambda t: t.slope,
        reverse=True,
    )
    improving = sorted(
        (t for t in trends if t.trajectory is Trajectory.IMPROVING),
        key=lambda t: t.slope,
    )
    return {
        "snapshots": snapshots,
        "window_days": window_days,
        "files": len(trends),
        "counts": counts,
        "hot": [t.to_dict() for t in fast[:hot_limit]],
        "rising": [t.to_dict() for t in slow[:hot_limit]],
        "improving": [t.to_dict() for t in improving[:hot_limit]],
        "entered_hot": [t.file for t in fast if t.entered_hot],
        "clusters": degrading_clusters(trends),
    }
