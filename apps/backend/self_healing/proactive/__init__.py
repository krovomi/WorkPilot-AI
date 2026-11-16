"""Risk trends of the proactive mode (#370): history, trajectories, clusters.

All deterministic and local, no model and no network: the snapshots come from
the fragility scan, the classes from the slope of each file's risk.
"""

from .clusters import build_trend_report, degrading_clusters
from .history_store import RiskHistoryStore
from .trajectory import FileTrend, Point, Trajectory, classify

__all__ = [
    "FileTrend",
    "Point",
    "RiskHistoryStore",
    "Trajectory",
    "build_trend_report",
    "classify",
    "degrading_clusters",
]
