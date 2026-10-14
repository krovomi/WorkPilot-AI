"""``CONTEXT_ACTION.json``: a one-shot "compact now" / "new thread now" request.

Written by the frontend (``TASK_CONTEXT_ACTION``) into every copy of the spec
dir while the build runs, like ``HOT_SWAP.json``; consumed by the running
session at its next safe point. ``phase`` and ``subtaskId`` are optional
targets: a parallel swarm worker only consumes a request aimed at its own
subtask, or at no subtask in particular.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

CONTEXT_ACTION_FILE = "CONTEXT_ACTION.json"
_ACTIONS = ("compact", "clear")


@dataclass(frozen=True)
class ContextActionRequest:
    action: str
    phase: str | None = None
    subtask_id: str | None = None


def _path(spec_dir: Path | str) -> Path:
    return Path(spec_dir) / CONTEXT_ACTION_FILE


def write_context_action(
    spec_dir: Path | str,
    action: str,
    phase: str | None = None,
    subtask_id: str | None = None,
) -> bool:
    """Persist a request (used by tests and the CLI). Best-effort."""
    if action not in _ACTIONS:
        return False
    payload = {
        "action": action,
        "phase": phase,
        "subtaskId": subtask_id,
        "requestedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        _path(spec_dir).write_text(json.dumps(payload), encoding="utf-8")
        return True
    except OSError:
        return False


def read_context_action(spec_dir: Path | str) -> ContextActionRequest | None:
    """The pending request, without removing it. None if absent or invalid."""
    path = _path(spec_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("action") not in _ACTIONS:
        return None
    phase = data.get("phase")
    subtask = data.get("subtaskId", data.get("subtask_id"))
    return ContextActionRequest(
        action=data["action"],
        phase=phase if isinstance(phase, str) and phase else None,
        subtask_id=subtask if isinstance(subtask, str) and subtask else None,
    )


def request_targets(
    request: ContextActionRequest | None, phase: str, subtask_id: str | None
) -> bool:
    """Whether ``request`` is aimed at this session. Pure."""
    if request is None:
        return False
    if request.phase and request.phase != phase:
        return False
    return not (request.subtask_id and request.subtask_id != subtask_id)


def consume_context_action(
    spec_dir: Path | str, phase: str, subtask_id: str | None
) -> ContextActionRequest | None:
    """Return and delete the request if it targets this session."""
    request = read_context_action(spec_dir)
    if not request_targets(request, phase, subtask_id):
        return None
    try:
        _path(spec_dir).unlink(missing_ok=True)
    except OSError:
        # An undeletable marker is read again at the next safe point, which
        # repeats the same requested action: harmless, and better than none.
        pass
    return request
