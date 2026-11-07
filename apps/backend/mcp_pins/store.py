"""The pins of a project: `.workpilot/mcp-pins.json`, and what a probe means against them.

One file per project, at the main checkout (a task's worktree under
`.workpilot/worktrees/tasks/<spec>` reads its project's file), protected from
the agents' writes (`security/path_guard.py`): an agent that could write it
would approve its own server.

First use. Requiring an approval for every server already configured would
switch off, on upgrade, servers the person set up themselves. So the first
time a project's pins are read, the configurations present then are recorded
as the person's (`trusted_configs`), and each of those servers is pinned on
first contact when no description looks poisoned. A server added afterwards
(by the person in the app, or by anything else writing `.workpilot/.env`)
waits for an approval, with its tools and their descriptions shown in clear.

After that, a tool added or a description changed is held back until the
person approves the change (rug pull), and a server whose command or URL
changed is a new server.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .fingerprint import ToolSnapshot, config_digest, schema_text
from .scan import description_findings

__all__ = [
    "APPROVED",
    "CHANGED",
    "PENDING",
    "PINS_FILE",
    "UNKNOWN",
    "PinError",
    "Verdict",
    "approve",
    "load_pins",
    "pins_path",
    "pins_root",
    "reconcile",
    "server_states",
]

PINS_FILE = "mcp-pins.json"
FIRST_USE = "first use"

APPROVED = "approved"
PENDING = "pending"
CHANGED = "changed"
UNKNOWN = "unknown"


class PinError(ValueError):
    """An approval that cannot be made as asked.

    ``code`` says which refusal it is (``unreadable``, ``nothing-pending``,
    ``suspicious``): the route answers with the code and a fixed sentence, and
    the message, which names a path of the checkout, stays in the log.
    """

    def __init__(self, message: str, code: str = "unreadable") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Verdict:
    server_id: str
    status: str
    #: The tools a session may see. Empty for pending and unknown.
    allowed: frozenset[str] = frozenset()
    held: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    detail: str = ""

    @property
    def exposed(self) -> bool:
        """Whether a provider that opens the server itself may start it."""
        return self.status == APPROVED


@dataclass
class _Pins:
    path: Path
    data: dict = field(default_factory=dict)

    @property
    def servers(self) -> dict:
        return self.data.setdefault("servers", {})


def pins_root(project_dir: Path | str) -> Path:
    """The main checkout of ``project_dir``, which may be a task's worktree."""
    path = Path(project_dir).resolve()
    parts = path.parts
    for i in range(len(parts) - 3, 0, -1):
        if parts[i : i + 3] == (".workpilot", "worktrees", "tasks"):
            return Path(*parts[:i])
    for i in range(len(parts) - 2, 0, -1):
        if parts[i] == ".worktrees":
            return Path(*parts[:i])
    return path


def pins_path(project_dir: Path | str) -> Path:
    return pins_root(project_dir) / ".workpilot" / PINS_FILE


def _now(now: datetime | None) -> str:
    return (now or datetime.now(UTC)).isoformat(timespec="seconds")


def _read(project_dir: Path | str) -> _Pins:
    path = pins_path(project_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _Pins(path)
    except (OSError, ValueError) as exc:
        # A damaged file approves nothing: never fall back to "first use".
        raise PinError(f"{path} is unreadable: {exc}") from exc
    if not isinstance(data, dict):
        raise PinError(f"{path} is not a JSON object")
    return _Pins(path, data)


def _write(pins: _Pins) -> None:
    pins.path.parent.mkdir(parents=True, exist_ok=True)
    pins.data["version"] = 1
    tmp = pins.path.with_name(pins.path.name + ".tmp")
    tmp.write_text(json.dumps(pins.data, indent=2, ensure_ascii=False), "utf-8")
    os.replace(tmp, pins.path)


def load_pins(project_dir: Path | str) -> dict:
    """The file's content (``{}`` when there is none). Raises `PinError` if damaged."""
    return _read(project_dir).data


def _bootstrap(pins: _Pins, configured: list[dict], now: datetime | None) -> None:
    if "bootstrapped_at" in pins.data:
        return
    pins.data["bootstrapped_at"] = _now(now)
    pins.data["trusted_configs"] = sorted({config_digest(c) for c in configured})


def _with_findings(
    tools: dict[str, ToolSnapshot], other_tools: set[str]
) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, tool in sorted(tools.items()):
        record = tool.as_record()
        text = tool.description + "\n" + schema_text(tool.input_schema)
        record["findings"] = description_findings(
            text, other_tools=other_tools - {name}, own_name=name
        )
        out[name] = record
    return out


def reconcile(
    project_dir: Path | str,
    config: dict,
    tools: list[ToolSnapshot] | None,
    *,
    configured: list[dict] | None = None,
    other_tools: set[str] | None = None,
    now: datetime | None = None,
) -> Verdict:
    """What a probe of one server means against the project's pins.

    ``tools`` is None when the server could not be listed: unknown, nothing
    exposed, nothing recorded. ``configured`` is every server the project
    declares, read the first time to record the person's own servers.
    ``other_tools`` are the tool names of the other servers (shadowing).
    """
    sid = str(config.get("id") or config.get("name") or "")
    if tools is None:
        return Verdict(sid, UNKNOWN, detail="the server could not be listed")
    pins = _read(project_dir)
    _bootstrap(pins, configured if configured is not None else [config], now)
    digest = config_digest(config)
    snapshot = {t.name: t for t in tools}
    record = pins.servers.get(sid)
    approved = (record or {}).get("approved") or {}
    same_program = record is not None and record.get("config") == digest
    changed = {
        name: tool
        for name, tool in snapshot.items()
        if not same_program or (approved.get(name) or {}).get("digest") != tool.digest
    }
    removed = sorted(set(approved) - set(snapshot)) if same_program else []
    stamp = _now(now)

    if not changed and record is not None:
        record["pending"] = None
        record["last_seen_at"] = stamp
        record["removed"] = removed
        _write(pins)
        return Verdict(sid, APPROVED, frozenset(snapshot), removed=tuple(removed))

    pending = _with_findings(changed, other_tools or set())
    suspicious = any(t["findings"] for t in pending.values())
    if (
        record is None
        and digest in pins.data.get("trusted_configs", [])
        and not suspicious
    ):
        pins.servers[sid] = {
            "config": digest,
            "approved": {n: snapshot[n].as_record() for n in sorted(snapshot)},
            "approved_at": stamp,
            "approved_by": FIRST_USE,
            "pending": None,
            "last_seen_at": stamp,
            "removed": [],
        }
        _write(pins)
        return Verdict(sid, APPROVED, frozenset(snapshot), detail=FIRST_USE)

    entry = record or {"config": digest, "approved": {}}
    entry["pending"] = {
        "config": digest,
        "seen_at": stamp,
        "tools": pending,
        "removed": removed,
        "program_changed": record is not None and not same_program,
    }
    entry["last_seen_at"] = stamp
    pins.servers[sid] = entry
    _write(pins)
    if record is None or not record.get("approved_at"):
        return Verdict(
            sid,
            PENDING,
            held=tuple(sorted(changed)),
            detail="a new server waits for the person's approval",
        )
    allowed = frozenset(set(snapshot) - set(changed)) if same_program else frozenset()
    return Verdict(
        sid,
        CHANGED,
        allowed,
        held=tuple(sorted(changed)),
        removed=tuple(removed),
        detail=(
            "its command or URL changed since the approval"
            if not same_program
            else "tools changed since the approval"
        ),
    )


def approve(
    project_dir: Path | str,
    server_id: str,
    *,
    by: str,
    confirm_suspicious: bool = False,
    now: datetime | None = None,
) -> dict:
    """Approve what the last probe of ``server_id`` saw; returns the server's entry."""
    pins = _read(project_dir)
    entry = pins.servers.get(server_id)
    pending = (entry or {}).get("pending")
    if not pending:
        raise PinError(
            f"nothing waits for an approval on {server_id!r}", code="nothing-pending"
        )
    suspicious = sorted(n for n, t in pending["tools"].items() if t.get("findings"))
    if suspicious and not confirm_suspicious:
        raise PinError(
            "these tools look poisoned and need an explicit confirmation: "
            + ", ".join(suspicious),
            code="suspicious",
        )
    approved = (
        {} if pending.get("program_changed") else dict(entry.get("approved") or {})
    )
    for name in pending.get("removed") or []:
        approved.pop(name, None)
    for name, tool in pending["tools"].items():
        approved[name] = {k: tool[k] for k in ("digest", "description", "inputSchema")}
    entry.update(
        config=pending["config"],
        approved=dict(sorted(approved.items())),
        approved_at=_now(now),
        approved_by=by or "the person",
        pending=None,
        removed=[],
    )
    _write(pins)
    return entry


def server_states(project_dir: Path | str) -> list[dict]:
    """Every pinned server, for the app: status, and what waits with the diff."""
    out: list[dict] = []
    for sid, entry in sorted(_read(project_dir).servers.items()):
        pending = entry.get("pending")
        status = (
            APPROVED
            if not pending
            else CHANGED
            if entry.get("approved_at")
            else PENDING
        )
        tools = []
        for name, tool in sorted(((pending or {}).get("tools") or {}).items()):
            before = (entry.get("approved") or {}).get(name)
            tools.append(
                {
                    "name": name,
                    "change": "changed" if before else "added",
                    "description": tool.get("description", ""),
                    "previousDescription": (before or {}).get("description"),
                    "inputSchema": tool.get("inputSchema") or {},
                    "findings": tool.get("findings") or [],
                }
            )
        out.append(
            {
                "serverId": sid,
                "status": status,
                "approvedAt": entry.get("approved_at"),
                "approvedBy": entry.get("approved_by"),
                "lastSeenAt": entry.get("last_seen_at"),
                "programChanged": bool((pending or {}).get("program_changed")),
                "removed": (pending or {}).get("removed") or entry.get("removed") or [],
                "approvedTools": sorted(entry.get("approved") or {}),
                "pendingTools": tools,
            }
        )
    return out
