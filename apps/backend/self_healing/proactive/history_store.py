"""Per-file risk snapshots, kept by the proactive scan (#370).

A fragility scan is a photograph: ``file X has a risk of 72 today``. A file at
72 for six months worries less than one that went from 35 to 68 in three
weeks, and only a history tells them apart. Each scan records the risk of
every file it measured (complexity, churn, coverage: the analyzer's own
metrics, so every language it reads), one snapshot per calendar day — a
second scan the same day replaces that day's rows rather than weighting it
twice.

The store is a stdlib SQLite file under ``.workpilot/self-healing/`` (ignored
by git), bounded: :data:`MAX_SNAPSHOTS` days and :data:`MAX_FILES_PER_SNAPSHOT`
files per day. Every failure is logged and swallowed: a history that cannot
be written never fails the scan.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterable
from contextlib import closing
from datetime import UTC, date, datetime
from pathlib import Path

from .trajectory import Point

logger = logging.getLogger(__name__)

__all__ = [
    "HISTORY_FILE",
    "MAX_FILES_PER_SNAPSHOT",
    "MAX_SNAPSHOTS",
    "RiskHistoryStore",
]

#: Relative to the project.
HISTORY_FILE = Path(".workpilot") / "self-healing" / "health_history.sqlite"
#: Snapshot days kept (a weekly scan: two years; a daily one: about four months).
MAX_SNAPSHOTS = 120
MAX_FILES_PER_SNAPSHOT = 5000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshot (
    day TEXT NOT NULL,
    file TEXT NOT NULL,
    risk REAL NOT NULL,
    complexity REAL NOT NULL DEFAULT 0,
    churn INTEGER NOT NULL DEFAULT 0,
    coverage REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, file)
)
"""


def _posix(path: str) -> str:
    """One spelling for a file on every OS: the analyzer's paths are native."""
    return path.replace("\\", "/")


class RiskHistoryStore:
    """Read and write the per-file risk history of one project."""

    def __init__(self, project_dir: str | Path, db_path: str | Path | None = None):
        self.project_dir = Path(project_dir)
        self.db_path = Path(db_path) if db_path else self.project_dir / HISTORY_FILE

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.db_path), timeout=5)
        connection.execute(_SCHEMA)
        return connection

    def record(
        self, reports: Iterable[object], taken_at: datetime | None = None
    ) -> str:
        """Store one snapshot of ``reports`` (``FragilityReport``); returns its day.

        Returns "" when nothing could be written.
        """
        day = (taken_at or datetime.now(UTC)).date().isoformat()
        rows: list[tuple[str, str, float, float, int, float]] = []
        for report in reports:
            file_path = _posix(str(getattr(report, "file_path", "") or ""))
            if not file_path:
                continue
            rows.append(
                (
                    day,
                    file_path,
                    float(getattr(report, "risk_score", 0.0) or 0.0),
                    float(getattr(report, "cyclomatic_complexity", 0.0) or 0.0),
                    int(getattr(report, "git_churn_count", 0) or 0),
                    float(getattr(report, "test_coverage_percent", 0.0) or 0.0),
                )
            )
            if len(rows) >= MAX_FILES_PER_SNAPSHOT:
                break
        if not rows:
            return ""
        try:
            with closing(self._connect()) as connection, connection:
                connection.execute("DELETE FROM snapshot WHERE day = ?", (day,))
                connection.executemany(
                    "INSERT OR REPLACE INTO snapshot VALUES (?, ?, ?, ?, ?, ?)", rows
                )
                connection.execute(
                    "DELETE FROM snapshot WHERE day NOT IN "
                    "(SELECT DISTINCT day FROM snapshot ORDER BY day DESC LIMIT ?)",
                    (MAX_SNAPSHOTS,),
                )
        except (sqlite3.Error, OSError) as exc:
            logger.warning("risk history not recorded: %s", exc)
            return ""
        return day

    def days(self) -> list[str]:
        """The snapshot days, oldest first."""
        if not self.db_path.is_file():
            return []
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT DISTINCT day FROM snapshot ORDER BY day"
                ).fetchall()
        except (sqlite3.Error, OSError) as exc:
            logger.warning("risk history unreadable: %s", exc)
            return []
        return [row[0] for row in rows]

    def series(self) -> dict[str, list[Point]]:
        """Every file's points, oldest first."""
        if not self.db_path.is_file():
            return {}
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT file, day, risk, complexity, churn, coverage "
                    "FROM snapshot ORDER BY file, day"
                ).fetchall()
        except (sqlite3.Error, OSError) as exc:
            logger.warning("risk history unreadable: %s", exc)
            return {}
        series: dict[str, list[Point]] = {}
        for file_path, day, risk, complexity, churn, coverage in rows:
            try:
                when = date.fromisoformat(day)
            except ValueError:
                continue
            series.setdefault(file_path, []).append(
                Point(when, float(risk), float(complexity), int(churn), float(coverage))
            )
        return series
