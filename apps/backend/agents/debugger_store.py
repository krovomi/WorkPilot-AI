"""
Agent Debugger — file-backed persistent store.

Why this exists
---------------
:class:`agents.debugger.DebuggerRegistry` keeps sessions in *process memory*.
That is fine for the live agent process (where the ``PreToolUse`` hook runs),
but the Electron UI drives the debugger through
``runners/agent_debugger_runner.py``, which is spawned as a **one-shot process
per IPC call**. In-memory state therefore never survives from one call to the
next: attach in one process, the process exits, and the next call sees an empty
registry — every breakpoint vanished instantly.

This module gives the runner a durable, cross-process source of truth: a single
JSON file that all one-shot invocations read and write. Breakpoints and paused
frames now persist, so the panel behaves like a real debugger surface.

Location
--------
Global (project-independent), because the runner is invoked with only a
``session_id`` and no project context. Override with the
``WORKPILOT_AGENT_DEBUGGER_STATE`` env var (used by tests); defaults to
``~/.workpilot/agent-debugger/state.json``.

Concurrency
-----------
UI-driven IPC calls are effectively sequential, so a full inter-process lock is
overkill. Writes are made atomic via ``os.replace`` so a reader never observes a
half-written file, and a corrupt/missing file degrades gracefully to empty
state.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

_ENV_VAR = "WORKPILOT_AGENT_DEBUGGER_STATE"

_BREAKPOINT_FIELDS = (
    "path_pattern",
    "content_pattern",
    "command_pattern",
)


def state_path() -> Path:
    """Resolve the state file path (env override or default user-level path)."""
    override = os.environ.get(_ENV_VAR)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".workpilot" / "agent-debugger" / "state.json"


def _empty_state() -> dict[str, Any]:
    return {"sessions": {}}


def _load() -> dict[str, Any]:
    path = state_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return _empty_state()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return _empty_state()
    if not isinstance(data, dict) or not isinstance(data.get("sessions"), dict):
        return _empty_state()
    return data


def _save(state: dict[str, Any]) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")
    os.replace(tmp, path)


def _session(state: dict[str, Any], session_id: str) -> dict[str, Any] | None:
    session = state["sessions"].get(session_id)
    return session if isinstance(session, dict) else None


def _summary(session_id: str, session: dict[str, Any]) -> dict[str, Any]:
    breakpoints = session.get("breakpoints") or []
    frames = [f for f in (session.get("frames") or []) if not f.get("resume_decision")]
    return {
        "session_id": session_id,
        "breakpoints": len(breakpoints),
        "frames": len(frames),
        "updated_at": session.get("updated_at"),
        "active": bool(session.get("active")),
        "meta": session.get("meta") or {},
    }


def _normalize_breakpoint(bp: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {
        "id": str(bp.get("id") or f"bp-{uuid.uuid4().hex[:8]}"),
        "tool": str(bp.get("tool") or "*"),
        "enabled": bool(bp.get("enabled", True)),
    }
    for field in _BREAKPOINT_FIELDS:
        value = bp.get(field)
        normalized[field] = str(value) if value else None
    return normalized


# ---------------------------------------------------------------------------
# Public API — mirrors the DebuggerSession surface used by the runner.
# ---------------------------------------------------------------------------


def attach(session_id: str) -> dict[str, Any]:
    """Create the session if missing; return its summary."""
    state = _load()
    session = _session(state, session_id)
    now = time.time()
    if session is None:
        session = {
            "created_at": now,
            "updated_at": now,
            "breakpoints": [],
            "frames": [],
        }
        state["sessions"][session_id] = session
        _save(state)
    return _summary(session_id, session)


def detach(session_id: str) -> bool:
    state = _load()
    if session_id not in state["sessions"]:
        return False
    del state["sessions"][session_id]
    _save(state)
    return True


def list_breakpoints(session_id: str) -> list[dict[str, Any]]:
    session = _session(_load(), session_id)
    if session is None:
        return []
    return list(session.get("breakpoints") or [])


def add_breakpoint(session_id: str, bp: dict[str, Any]) -> str:
    state = _load()
    session = _session(state, session_id)
    if session is None:
        attach(session_id)
        state = _load()
        session = _session(state, session_id)
        assert session is not None  # noqa: S101 — just created above
    normalized = _normalize_breakpoint(bp)
    breakpoints = [
        b for b in session.get("breakpoints") or [] if b.get("id") != normalized["id"]
    ]
    breakpoints.append(normalized)
    session["breakpoints"] = breakpoints
    session["updated_at"] = time.time()
    _save(state)
    return normalized["id"]


def remove_breakpoint(session_id: str, bp_id: str) -> bool:
    state = _load()
    session = _session(state, session_id)
    if session is None:
        return False
    before = session.get("breakpoints") or []
    after = [b for b in before if b.get("id") != bp_id]
    if len(after) == len(before):
        return False
    session["breakpoints"] = after
    session["updated_at"] = time.time()
    _save(state)
    return True


def list_frames(session_id: str) -> list[dict[str, Any]]:
    """Return frames still awaiting a resume decision."""
    session = _session(_load(), session_id)
    if session is None:
        return []
    return [f for f in (session.get("frames") or []) if not f.get("resume_decision")]


def resume(session_id: str, frame_id: str, decision: dict[str, Any]) -> bool:
    state = _load()
    session = _session(state, session_id)
    if session is None:
        return False
    frame = next(
        (f for f in session.get("frames") or [] if f.get("frame_id") == frame_id),
        None,
    )
    if frame is None:
        return False
    frame["resume_decision"] = decision
    session["updated_at"] = time.time()
    _save(state)
    return True


def list_sessions() -> list[dict[str, Any]]:
    """Return a summary of every persisted session (for the UI picker)."""
    state = _load()
    return [
        _summary(sid, session)
        for sid, session in state["sessions"].items()
        if isinstance(session, dict)
    ]


# ---------------------------------------------------------------------------
# Live-run integration — used by the agent process (make_persistent_debugger_hook)
# to publish paused frames cross-process and by create_client to advertise a
# session as "live" so the UI can attach to it.
# ---------------------------------------------------------------------------


def add_frame(session_id: str, frame: dict[str, Any]) -> str:
    """Append a *pending* frame (a paused tool call) and return its id.

    Called from the live agent process when a breakpoint fires. Auto-attaches
    the session so a race with detach never drops the frame.
    """
    state = _load()
    session = _session(state, session_id)
    now = time.time()
    if session is None:
        session = {
            "created_at": now,
            "updated_at": now,
            "breakpoints": [],
            "frames": [],
        }
        state["sessions"][session_id] = session
    stored = dict(frame)
    stored["frame_id"] = str(stored.get("frame_id") or uuid.uuid4())
    stored.setdefault("session_id", session_id)
    stored.setdefault("captured_at", now)
    stored.pop("resume_decision", None)  # a fresh frame is always pending
    session.setdefault("frames", []).append(stored)
    session["updated_at"] = now
    _save(state)
    return stored["frame_id"]


def get_frame(session_id: str, frame_id: str) -> dict[str, Any] | None:
    session = _session(_load(), session_id)
    if session is None:
        return None
    return next(
        (f for f in session.get("frames") or [] if f.get("frame_id") == frame_id),
        None,
    )


def remove_frame(session_id: str, frame_id: str) -> bool:
    state = _load()
    session = _session(state, session_id)
    if session is None:
        return False
    before = session.get("frames") or []
    after = [f for f in before if f.get("frame_id") != frame_id]
    if len(after) == len(before):
        return False
    session["frames"] = after
    session["updated_at"] = time.time()
    _save(state)
    return True


def session_exists(session_id: str) -> bool:
    """Cheap check (single ``stat`` when the file is absent) used by
    ``create_client`` to decide whether to install the debugger hook."""
    try:
        state_path().stat()
    except OSError:
        return False
    return session_id in _load().get("sessions", {})


def session_is_armed(session_id: str) -> bool:
    """True when the session has at least one enabled breakpoint.

    Fast-paths on file absence so the live hook pays a single ``stat`` per tool
    call on runs where the debugger has never been used.
    """
    try:
        state_path().stat()
    except OSError:
        return False
    session = _session(_load(), session_id)
    if session is None:
        return False
    return any(b.get("enabled", True) for b in session.get("breakpoints") or [])


def register_active(session_id: str, meta: dict[str, Any] | None = None) -> None:
    """Advertise a session as a live agent run so the UI can attach to it."""
    state = _load()
    session = _session(state, session_id)
    now = time.time()
    if session is None:
        session = {"created_at": now, "breakpoints": [], "frames": []}
        state["sessions"][session_id] = session
    session["active"] = True
    session["updated_at"] = now
    session["meta"] = {**(session.get("meta") or {}), **(meta or {}), "heartbeat": now}
    _save(state)


def deactivate(session_id: str) -> bool:
    """Mark a live session as no longer running (called from the Stop hook)."""
    state = _load()
    session = _session(state, session_id)
    if session is None:
        return False
    session["active"] = False
    session["updated_at"] = time.time()
    _save(state)
    return True
