"""Where the train keeps its runs: ``.workpilot/release-train/``.

``runs/<id>.json`` holds one run (its items, flags, journal), rewritten
atomically after each step, so a run the app closed mid-way is found again
as it was. ``runs/<id>.lock`` names the process driving the run: a second
process refuses to drive it while that one lives, and a lock whose process is
gone is taken over (the step it was on is marked interrupted).
``history.jsonl`` gets one line per finished run, for the metrics. The folder
is WorkPilot's (ignored by git); a link on the way is never followed.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from foundation.file_utils import atomic_write
from foundation.platform import pid_is_running

RUN_ID = re.compile(r"^rt-\d{8}-\d{6}-[0-9a-f]{6}$")
MAX_RUNS = 50
MAX_HISTORY = 2000
MAX_RUN_BYTES = 4 * 1024 * 1024


class RunError(ValueError):
    """A run that cannot be read or driven now."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _folder(root: Path, *parts: str, create: bool) -> Path | None:
    current = root
    for part in (".workpilot", "release-train", *parts):
        current = current / part
        if current.is_symlink():
            return None
        if not current.exists():
            if not create:
                return None
            current.mkdir()
    return current


def _run_path(root: Path, run_id: str, suffix: str, create: bool) -> Path:
    if not RUN_ID.match(run_id):
        raise RunError("not a run id")
    folder = _folder(root, "runs", create=create)
    if folder is None:
        raise RunError("no such run")
    path = folder / f"{run_id}{suffix}"
    if path.is_symlink():
        raise RunError("no such run")
    return path


def save(root: Path, run: dict[str, Any]) -> None:
    run["updatedAt"] = now_iso()
    path = _run_path(root, str(run["id"]), ".json", create=True)
    with atomic_write(path) as handle:
        json.dump(run, handle, ensure_ascii=False, indent=1)


def load(root: Path, run_id: str) -> dict[str, Any]:
    path = _run_path(root, run_id, ".json", create=False)
    if not path.is_file() or path.stat().st_size > MAX_RUN_BYTES:
        raise RunError("no such run")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise RunError("the run file is damaged") from exc
    if not isinstance(data, dict) or data.get("id") != run_id:
        raise RunError("the run file is damaged")
    return data


def list_runs(root: Path) -> list[dict[str, Any]]:
    """The latest runs, newest first, without their journal."""
    folder = _folder(root, "runs", create=False)
    if folder is None:
        return []
    found: list[dict[str, Any]] = []
    names = sorted(
        (p.stem for p in folder.glob("rt-*.json") if RUN_ID.match(p.stem)), reverse=True
    )
    for name in names[:MAX_RUNS]:
        try:
            run = load(root, name)
        except RunError:
            continue
        found.append({k: v for k, v in run.items() if k != "journal"})
    return found


class RunLock:
    """``runs/<id>.lock`` held by this process while it drives the run."""

    def __init__(self, root: Path, run_id: str) -> None:
        self.path = _run_path(root, run_id, ".lock", create=True)
        self.taken_over = False

    def __enter__(self) -> RunLock:
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                try:
                    pid = int(self.path.read_text(encoding="utf-8").strip() or "0")
                except (OSError, ValueError):
                    pid = 0
                if pid and pid_is_running(pid):
                    raise RunError("this run is already being driven") from None
                self.path.unlink(missing_ok=True)
                self.taken_over = True
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
            return self
        raise RunError("this run is already being driven")

    def __exit__(self, *exc: object) -> None:
        self.path.unlink(missing_ok=True)


def record(root: Path, entry: dict[str, Any]) -> None:
    folder = _folder(root, create=True)
    if folder is None:
        return
    path = folder / "history.jsonl"
    if path.is_symlink():
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def history(root: Path) -> list[dict[str, Any]]:
    folder = _folder(root, create=False)
    path = folder / "history.jsonl" if folder else None
    if path is None or path.is_symlink() or not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines()[-MAX_HISTORY:]:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def last_shipped(root: Path, environment: str) -> dict[str, str]:
    """The version each service last shipped to ``environment``, by finished runs."""
    versions: dict[str, str] = {}
    for row in history(root):
        if row.get("environment") != environment:
            continue
        shipped = row.get("shipped")
        if isinstance(shipped, dict):
            versions.update(
                {str(k): str(v) for k, v in shipped.items() if isinstance(v, str)}
            )
        rolled = row.get("rolledBack")
        if isinstance(rolled, dict):
            versions.update(
                {str(k): str(v) for k, v in rolled.items() if isinstance(v, str)}
            )
    return versions


def metrics(root: Path) -> list[dict[str, Any]]:
    """Per month: trains, multi-service trains, mean minutes, blocking gates, rollbacks."""
    months: dict[str, dict[str, Any]] = {}
    for row in history(root):
        at = str(row.get("endedAt", ""))[:7]
        if len(at) != 7:
            continue
        month = months.setdefault(
            at,
            {
                "month": at,
                "trains": 0,
                "multiService": 0,
                "minutes": 0.0,
                "done": 0,
                "blockedByGates": 0,
                "rollbacks": 0,
                "rollbacksOk": 0,
            },
        )
        month["trains"] += 1
        if int(row.get("services", 0) or 0) > 1:
            month["multiService"] += 1
        if row.get("status") == "done":
            month["done"] += 1
            month["minutes"] += float(row.get("minutes", 0) or 0)
        month["blockedByGates"] += int(row.get("gateFailures", 0) or 0)
        if row.get("status") in ("rolled_back", "rollback_failed"):
            month["rollbacks"] += 1
            if row.get("status") == "rolled_back":
                month["rollbacksOk"] += 1
    out = []
    for month in sorted(months.values(), key=lambda m: m["month"])[-12:]:
        done = month.pop("done")
        total = month.pop("minutes")
        month["meanMinutes"] = round(total / done, 1) if done else None
        out.append(month)
    return out


__all__ = [
    "RunError",
    "RunLock",
    "history",
    "last_shipped",
    "list_runs",
    "load",
    "metrics",
    "now_iso",
    "record",
    "save",
]
