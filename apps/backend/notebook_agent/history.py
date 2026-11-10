"""One line per notebook run, and the monthly figures the page shows.

``.workpilot/notebooks/history.jsonl`` in the project (ignored by git, never
in a review branch): scans (notebooks read, dependency findings), runs
(reproducibility score) and refactors (functions extracted). No code and
no output is kept, only counts.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

__all__ = ["HISTORY", "metrics", "record"]

HISTORY = Path(".workpilot") / "notebooks" / "history.jsonl"
_FLOW_ISSUES = frozenset(
    {
        "used_before_defined",
        "undefined_name",
        "hidden_state",
        "implicit_global",
        "shared_mutation",
    }
)
MAX_BYTES = 4 * 1024 * 1024


def _path(project: Path) -> Path | None:
    folder = project / ".workpilot"
    if folder.is_symlink() or not folder.is_dir():
        return None
    notebooks = folder / "notebooks"
    if notebooks.is_symlink():
        return None
    notebooks.mkdir(exist_ok=True)
    path = project / HISTORY
    return None if path.is_symlink() else path


def record(project: Path, kind: str, **counts: Any) -> None:
    """Append one line; a project without ``.workpilot/`` keeps no history."""
    path = _path(project)
    if path is None:
        return
    line = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "kind": kind,
        **counts,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line) + "\n")


def flow_issue_count(notebooks: list[dict[str, Any]]) -> int:
    return sum(
        1
        for nb in notebooks
        for issue in nb.get("issues", [])
        if issue.get("issueType") in _FLOW_ISSUES
    )


def metrics(project: Path) -> list[dict[str, Any]]:
    """Per month (twelve at most): notebooks scanned, findings, runs, mean score, functions extracted."""
    path = project / HISTORY
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        return []
    months: dict[str, dict[str, Any]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(line, dict) or not isinstance(line.get("at"), str):
            continue
        month = months.setdefault(
            line["at"][:7],
            {
                "month": line["at"][:7],
                "notebooks": 0,
                "findings": 0,
                "runs": 0,
                "scores": [],
                "extracted": 0,
            },
        )
        kind = line.get("kind")
        if kind == "scan":
            month["notebooks"] += int(line.get("notebooks") or 0)
            month["findings"] += int(line.get("findings") or 0)
        elif kind == "execute":
            month["runs"] += 1
            if isinstance(line.get("score"), int):
                month["scores"].append(line["score"])
        elif kind == "refactor":
            month["extracted"] += int(line.get("extracted") or 0)
    out = []
    for key in sorted(months)[-12:]:
        month = months[key]
        scores = month.pop("scores")
        month["meanScore"] = round(sum(scores) / len(scores)) if scores else None
        out.append(month)
    return out
