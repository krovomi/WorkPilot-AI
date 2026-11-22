"""The run of "Execute in optimal order" of a server project, and its history,
in the clone: ``.workpilot/execution-waves-run.json`` and
``.workpilot/execution-waves-history.json`` (the desktop's file names and
shape, so a record means the same on both).

The state is rebuilt field by field when read and before it is written:
at least one wave, none empty, at most 200 cards each named like a card and
in one wave only, the current wave within the waves, the advance rule in a
closed list, the parallelism 1 to 32, every started card in a wave, bounded
counters. ``.workpilot`` must be a real folder of the clone (not a link),
the files may not be links, a read is bounded, and a write goes to a fresh
temporary file (exclusive, ``0600``) renamed over the target.
"""

from __future__ import annotations

import json
import os
import stat
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

RUN_FILE = "execution-waves-run.json"
HISTORY_FILE = "execution-waves-history.json"
VERSION = 1
MAX_RUN_BYTES = 256 * 1024
MAX_HISTORY_BYTES = 128 * 1024
MAX_RECORDS = 100
MAX_TASKS = 200
MAX_PARALLEL = 32
MAX_COUNT = 1_000_000
ADVANCE = frozenset({"merged", "review"})
OUTCOMES = frozenset({"done", "stopped"})
#: Why a card of the run was not started (shown, never a free text).
START_FAILURES = frozenset(
    {"needs_approval", "claimed", "already_running", "quota", "refused", "missing"}
)
SPRINT_DAYS = 14


class StoreRefused(RuntimeError):
    """The clone's ``.workpilot`` or a run file is a link or not where it should be."""


def _card_id(value: Any) -> bool:
    from board_mcp.server import CARD_ID

    return isinstance(value, str) and bool(CARD_ID.match(value))


def _count(value: Any, ceiling: int = MAX_COUNT) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= ceiling else None


def _moment(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat()


def validate_run(raw: Any, project_id: str) -> dict[str, Any] | None:
    """A coherent run state, rebuilt; None otherwise."""
    if not isinstance(raw, dict) or raw.get("projectId") != project_id:
        return None
    waves = raw.get("waves")
    if not isinstance(waves, list) or not 0 < len(waves) <= MAX_TASKS:
        return None
    lists: list[list[str]] = []
    for wave in waves:
        if (
            not isinstance(wave, list)
            or not wave
            or not all(_card_id(card) for card in wave)
        ):
            return None
        lists.append(list(wave))
    every = [card for wave in lists for card in wave]
    if len(every) > MAX_TASKS or len(set(every)) != len(every):
        return None
    current = _count(raw.get("current"), len(lists))
    advance = raw.get("advanceWhen")
    parallel = _count(raw.get("maxParallel"), MAX_PARALLEL)
    if current is None or advance not in ADVANCE or not parallel:
        return None
    started = raw.get("started")
    if (
        not isinstance(started, list)
        or not all(_card_id(card) and card in every for card in started)
        or len(set(started)) != len(started)
    ):
        return None
    state: dict[str, Any] = {
        "projectId": project_id,
        "waves": lists,
        "current": current,
        "advanceWhen": advance,
        "maxParallel": parallel,
        "started": list(started),
    }
    avoided = raw.get("avoided")
    if avoided is not None:
        if not isinstance(avoided, dict):
            return None
        conflicts, risk = _count(avoided.get("conflicts")), _count(avoided.get("risk"))
        if conflicts is None or risk is None:
            return None
        state["avoided"] = {"conflicts": conflicts, "risk": risk}
    started_by = raw.get("startedBy")
    if started_by is not None:
        if not isinstance(started_by, str) or not 0 < len(started_by) <= 64:
            return None
        state["startedBy"] = started_by
    failures = raw.get("failures", {})
    if not isinstance(failures, dict) or not all(
        card in every and reason in START_FAILURES for card, reason in failures.items()
    ):
        return None
    state["failures"] = dict(failures)
    if raw.get("options") is not None:
        from .service import parse_options

        options = parse_options(raw["options"])
        if options is None:
            return None
        state["options"] = options.as_dict()
    return state


def workpilot_dir(clone: Path, create: bool) -> Path | None:
    """The clone's own ``.workpilot``, resolved; refused when it is a link."""
    root = Path(os.path.realpath(clone))
    directory = root / ".workpilot"
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        if not create:
            return None
        directory.mkdir()
        info = os.lstat(directory)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise StoreRefused("linked or non-folder .workpilot")
    if Path(os.path.realpath(directory)) != directory:
        raise StoreRefused(".workpilot outside the clone")
    return directory


def read_bounded(file: Path, limit: int) -> str:
    """The file's text; raises (FileNotFoundError when missing) otherwise."""
    before = os.lstat(file)
    if stat.S_ISLNK(before.st_mode):
        raise StoreRefused("linked file")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_ino, opened.st_dev) != (
            before.st_ino,
            before.st_dev,
        ):
            raise StoreRefused("not the file checked")
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit:
        raise StoreRefused("oversized file")
    return data.decode("utf-8")


def write_atomically(clone: Path, name: str, body: str) -> None:
    # Created when missing: never None here.
    directory = cast(Path, workpilot_dir(clone, True))
    target = directory / name
    if target.is_symlink():
        raise StoreRefused("linked file")
    temp = directory / f".{name}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body)
        os.replace(temp, target)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


def _read(clone: Path, name: str, limit: int) -> tuple[Any, bool]:
    """(parsed JSON or None, ignored)."""
    try:
        directory = workpilot_dir(clone, False)
        if directory is None:
            return None, False
        text = read_bounded(directory / name, limit)
    except FileNotFoundError:
        return None, False
    except (OSError, StoreRefused, UnicodeDecodeError):
        return None, True
    try:
        return json.loads(text), False
    except ValueError:
        return None, True


def load_run(
    clone: Path, project_id: str, known: set[str]
) -> tuple[dict[str, Any] | None, bool]:
    """(the saved run, ignored): a run naming a card the clone no longer has is ignored."""
    raw, ignored = _read(clone, RUN_FILE, MAX_RUN_BYTES)
    if raw is None:
        return None, ignored
    saved_at = _moment(raw.get("savedAt")) if isinstance(raw, dict) else None
    state = (
        validate_run(raw, project_id)
        if isinstance(raw, dict) and raw.get("version") == VERSION
        else None
    )
    if state is None or saved_at is None:
        return None, True
    if not all(card in known for wave in state["waves"] for card in wave):
        return None, True
    return {**state, "savedAt": saved_at}, False


def save_run(clone: Path, state: dict[str, Any], now: datetime) -> dict[str, Any]:
    checked = validate_run(state, state.get("projectId", ""))
    if checked is None:
        raise ValueError("incoherent run state")
    saved = {"version": VERSION, **checked, "savedAt": now.isoformat()}
    write_atomically(clone, RUN_FILE, json.dumps(saved))
    return {k: v for k, v in saved.items() if k != "version"}


def clear_run(clone: Path) -> None:
    directory = workpilot_dir(clone, False)
    if directory is not None:
        target = directory / RUN_FILE
        if target.exists() or target.is_symlink():
            target.unlink()


def validate_record(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    finished = _moment(raw.get("finishedAt"))
    outcome = raw.get("outcome")
    counts = {
        "waves": _count(raw.get("waves"), MAX_TASKS),
        "tasks": _count(raw.get("tasks"), MAX_TASKS),
        "started": _count(raw.get("started"), MAX_TASKS),
        "conflictsAvoided": _count(raw.get("conflictsAvoided")),
        "riskAvoided": _count(raw.get("riskAvoided")),
    }
    if finished is None or outcome not in OUTCOMES or None in counts.values():
        return None
    return {"finishedAt": finished, "outcome": outcome, **counts}


def load_history(clone: Path) -> dict[str, Any]:
    raw, ignored = _read(clone, HISTORY_FILE, MAX_HISTORY_BYTES)
    if raw is None:
        return {"records": [], "ignored": ignored}
    if (
        not isinstance(raw, dict)
        or raw.get("version") != VERSION
        or not isinstance(raw.get("records"), list)
    ):
        return {"records": [], "ignored": True}
    records = [validate_record(r) for r in raw["records"][:MAX_RECORDS]]
    if any(r is None for r in records):
        return {"records": [], "ignored": True}
    return {"records": records, "ignored": False}


def record_of(run: dict[str, Any], outcome: str, now: datetime) -> dict[str, Any]:
    avoided = run.get("avoided") or {}
    return {
        "finishedAt": now.isoformat(),
        "outcome": outcome,
        "waves": len(run["waves"]),
        "tasks": sum(len(w) for w in run["waves"]),
        "started": len(run["started"]),
        "conflictsAvoided": avoided.get("conflicts", 0),
        "riskAvoided": avoided.get("risk", 0),
    }


def end_run(clone: Path, run: dict[str, Any], outcome: str, now: datetime) -> None:
    """Records the run in front of the history, then forgets it."""
    if outcome not in OUTCOMES:
        raise ValueError("unknown outcome")
    records = [record_of(run, outcome, now), *load_history(clone)["records"]]
    write_atomically(
        clone,
        HISTORY_FILE,
        json.dumps({"version": VERSION, "records": records[:MAX_RECORDS]}),
    )
    clear_run(clone)


def sprint_summary(history: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The last 14 days: runs ended, stopped, conflicts avoided, risk taken out,
    cards started, when the last one ended. Counts only, never a duration."""
    since = now - timedelta(days=SPRINT_DAYS)
    recent = [
        r
        for r in history["records"]
        if datetime.fromisoformat(r["finishedAt"]) >= since
    ]
    return {
        "days": SPRINT_DAYS,
        "runs": len(recent),
        "stopped": sum(1 for r in recent if r["outcome"] == "stopped"),
        "conflictsAvoided": sum(r["conflictsAvoided"] for r in recent),
        "riskAvoided": sum(r["riskAvoided"] for r in recent),
        "started": sum(r["started"] for r in recent),
        "lastFinishedAt": recent[0]["finishedAt"] if recent else None,
    }
