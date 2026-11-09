"""The accessibility score, its breakdown by WCAG criterion, and its history (#391).

A score from 0 to 100 that does not need explaining twice: every violation
weighs by its severity (critical 10, serious 6, moderate 3, minor 1) and the
score is ``100 × K / (K + weight)``, with ``K = 10`` per markup file scanned.
So a project of ten files with one critical violation scores 91, and two
projects of different sizes are compared on the same footing. Each file and
each criterion get the same formula, which is what "comparable over time"
needs: the same code always scores the same.

The history is ``.workpilot/accessibility/history.jsonl`` in the project, one
line per scan, the last 200 kept.
"""

from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "HISTORY_FILE",
    "SEVERITY_WEIGHTS",
    "append_history",
    "breakdown",
    "by_file",
    "read_history",
    "score",
]

logger = logging.getLogger(__name__)

SEVERITY_WEIGHTS = {"critical": 10, "serious": 6, "moderate": 3, "minor": 1}
PER_FILE = 10
HISTORY_FILE = Path(".workpilot") / "accessibility" / "history.jsonl"
MAX_HISTORY = 200

CRITERIA_NAMES = {
    "1.1.1": "Non-text content",
    "1.2.2": "Captions (prerecorded)",
    "1.3.1": "Info and relationships",
    "1.4.3": "Contrast (minimum)",
    "1.4.4": "Resize text",
    "1.4.6": "Contrast (enhanced)",
    "2.1.1": "Keyboard",
    "2.1.2": "No keyboard trap",
    "2.4.1": "Bypass blocks",
    "2.4.2": "Page titled",
    "2.4.3": "Focus order",
    "2.4.4": "Link purpose",
    "2.4.7": "Focus visible",
    "2.5.5": "Target size (enhanced)",
    "2.5.8": "Target size (minimum)",
    "3.1.1": "Language of page",
    "4.1.2": "Name, role, value",
}


def _weight(violations: list[dict]) -> int:
    return sum(SEVERITY_WEIGHTS.get(v.get("severity", ""), 1) for v in violations)


def score(violations: list[dict], files: int) -> int:
    k = PER_FILE * max(1, files)
    return round(100 * k / (k + _weight(violations)))


def breakdown(violations: list[dict], files: int) -> list[dict]:
    """One row per WCAG criterion that has a violation, worst first."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for v in violations:
        grouped[v.get("wcagCriteria", "")].append(v)
    rows = [
        {
            "criterion": criterion,
            "name": CRITERIA_NAMES.get(criterion, ""),
            "level": items[0].get("wcagLevel", ""),
            "count": len(items),
            "score": score(items, files),
        }
        for criterion, items in grouped.items()
    ]
    return sorted(rows, key=lambda r: (r["score"], r["criterion"]))


def by_file(violations: list[dict], files: list[str]) -> list[dict]:
    """The score of each page or component that has a violation, worst first."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for v in violations:
        grouped[v.get("file", "")].append(v)
    rows = [
        {"file": f, "count": len(grouped[f]), "score": score(grouped[f], 1)}
        for f in files
        if grouped.get(f)
    ]
    return sorted(rows, key=lambda r: (r["score"], r["file"]))[:200]


def read_history(project: Path, limit: int = 30) -> list[dict]:
    path = project / HISTORY_FILE
    try:
        if path.is_symlink() or not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()[-limit:]
    except OSError:
        return []
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("score"), int):
            entries.append(entry)
    return entries


def append_history(project: Path, report: dict) -> dict:
    """Record this scan; a folder that is a link or cannot be written records nothing."""
    entry = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "score": report["score"],
        "targetLevel": report["targetLevel"],
        "violations": len(report["violations"]),
        "filesScanned": report["filesScanned"],
        "bySeverity": {
            s: sum(1 for v in report["violations"] if v["severity"] == s)
            for s in SEVERITY_WEIGHTS
        },
    }
    path = project / HISTORY_FILE
    try:
        for parent in (project / ".workpilot", path.parent):
            if parent.is_symlink():
                return entry
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            return entry
        kept = (
            path.read_text(encoding="utf-8").splitlines()[-(MAX_HISTORY - 1) :]
            if path.is_file()
            else []
        )
        path.write_text("\n".join([*kept, json.dumps(entry)]) + "\n", encoding="utf-8")
    except OSError as exc:
        logger.debug("accessibility history not written: %s", exc)
    return entry
