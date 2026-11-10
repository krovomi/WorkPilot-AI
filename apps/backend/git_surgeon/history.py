"""What the surgeon did, month by month: ``.workpilot/git-surgeon/history.jsonl``.

One line per applied plan: the date, the new branch, the counts of squashed,
reworded, split and kept steps, and the readability before and after. The
folder is WorkPilot's (ignored by git); a link on the way is never followed.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

MAX_LINES = 2000


def _folder(repo: Path, create: bool) -> Path | None:
    current = repo
    for part in (".workpilot", "git-surgeon"):
        current = current / part
        if current.is_symlink():
            return None
        if not current.exists():
            if not create:
                return None
            current.mkdir()
    return current


def record(repo: Path, entry: dict[str, object]) -> None:
    folder = _folder(repo, create=True)
    if folder is None:
        return
    path = folder / "history.jsonl"
    if path.is_symlink():
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read(repo: Path) -> list[dict[str, object]]:
    folder = _folder(repo, create=False)
    path = folder / "history.jsonl" if folder else None
    if path is None or path.is_symlink() or not path.is_file():
        return []
    rows: list[dict[str, object]] = []
    for line in path.read_text(encoding="utf-8").splitlines()[-MAX_LINES:]:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def monthly(repo: Path) -> list[dict[str, object]]:
    """Per month: runs, squashes, rewords, splits, and the last readability reached."""
    months: dict[str, dict[str, object]] = {}
    for row in read(repo):
        at = str(row.get("at", ""))[:7]
        if len(at) != 7:
            continue
        counts = row.get("counts") if isinstance(row.get("counts"), dict) else {}
        month = months.setdefault(
            at, {"month": at, "runs": 0, "squash": 0, "reword": 0, "split": 0}
        )
        month["runs"] = int(month["runs"]) + 1  # type: ignore[arg-type]
        for kind in ("squash", "reword", "split"):
            value = counts.get(kind, 0) if isinstance(counts, dict) else 0
            month[kind] = int(month[kind]) + (value if isinstance(value, int) else 0)  # type: ignore[arg-type]
        after = row.get("after")
        if isinstance(after, int):
            month["readability"] = after
    return sorted(months.values(), key=lambda m: str(m["month"]))[-12:]


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
