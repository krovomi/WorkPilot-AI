"""The build log of a server card, as the app's Logs tab draws it.

An agent run on the server writes its journal to ``task_logs.json``
(``task_logger``), in the card's spec folder for the spec and planning steps
and in the build workspace's copy once the build has one. The desktop app
merges the two copies the same way for a local card
(``apps/frontend/src/main/task-log-service.ts``, ``mergeLogs``); this module
does it on the server, so a member who did not start the run still sees what
the agent does, on the desktop and on the phone.

What leaves the server is bounded and masked: each copy is read only when it
is a regular file of at most :data:`MAX_LOG_BYTES` (a link out of the clone is
not followed), a phase keeps its last :data:`MAX_ENTRIES` entries, a text
field its last :data:`MAX_TEXT` characters, and every text goes through
:func:`foundation.log_redaction.redact_text`, since the readers are other
members of the project.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

LOG_FILE = "task_logs.json"
PHASES: tuple[str, ...] = ("planning", "coding", "validation")

#: The most of one ``task_logs.json`` copy read from disk.
MAX_LOG_BYTES = 8_000_000
#: The most entries a phase sends (the latest ones).
MAX_ENTRIES = 1_000
#: The most characters of one text field sent (its end, where the news is).
MAX_TEXT = 8_000


def _read(path: Path, root: Path) -> dict[str, Any] | None:
    try:
        if (
            not path.is_file()
            or path.is_symlink()
            or not path.resolve().is_relative_to(root)
            or path.stat().st_size > MAX_LOG_BYTES
        ):
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("phases"), dict):
        return None
    return value


def _entries(phase: Any) -> int:
    if not isinstance(phase, dict):
        return 0
    entries = phase.get("entries")
    return len(entries) if isinstance(entries, list) else 0


def _active(phase: Any) -> bool:
    """A phase this copy has worked on (the workspace copy wins then)."""
    return isinstance(phase, dict) and (
        _entries(phase) > 0 or phase.get("status", "pending") != "pending"
    )


def merge_logs(
    main: dict[str, Any] | None, workspace: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The two copies as one, by the app's rule: planning from the copy with
    more entries, coding and validation from the workspace once it has
    worked on them."""
    if workspace is None:
        return main
    if main is None:
        return workspace
    main_phases = main.get("phases") or {}
    ws_phases = workspace.get("phases") or {}
    phases: dict[str, Any] = {}
    planning_ws = ws_phases.get("planning")
    planning_main = main_phases.get("planning")
    phases["planning"] = (
        planning_ws
        if _entries(planning_ws) > _entries(planning_main)
        else (planning_main or planning_ws)
    )
    for name in ("coding", "validation"):
        ws = ws_phases.get(name)
        phases[name] = ws if _active(ws) else (main_phases.get(name) or ws)
    return {
        "spec_id": main.get("spec_id") or workspace.get("spec_id"),
        "created_at": main.get("created_at") or workspace.get("created_at"),
        "updated_at": max(
            str(main.get("updated_at") or ""), str(workspace.get("updated_at") or "")
        ),
        "phases": phases,
    }


def _masked(value: Any) -> Any:
    from foundation.log_redaction import redact_text

    if isinstance(value, str):
        return redact_text(value[-MAX_TEXT:])
    if isinstance(value, dict):
        return {key: _masked(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_masked(item) for item in value]
    return value


def bounded(logs: dict[str, Any]) -> dict[str, Any]:
    """`logs` cut to what one answer sends, every text masked."""
    phases: dict[str, Any] = {}
    truncated = False
    for name in PHASES:
        phase = (logs.get("phases") or {}).get(name)
        if not isinstance(phase, dict):
            phase = {"phase": name, "status": "pending", "entries": []}
        entries = phase.get("entries")
        entries = entries if isinstance(entries, list) else []
        if len(entries) > MAX_ENTRIES:
            truncated = True
            entries = entries[-MAX_ENTRIES:]
        phases[name] = _masked({**phase, "entries": entries})
    return {
        "spec_id": logs.get("spec_id"),
        "created_at": logs.get("created_at"),
        "updated_at": logs.get("updated_at"),
        "phases": phases,
        "truncated": truncated,
    }


def card_logs(root: Path, directory: Path) -> dict[str, Any] | None:
    """The card's build log, or ``None`` when no run has written one yet."""
    from shared_board.listing import card_source

    root = root.resolve()
    source = card_source(root, directory)
    main = _read(directory / LOG_FILE, root)
    workspace = _read(source / LOG_FILE, root) if source != directory else None
    merged = merge_logs(main, workspace)
    return bounded(merged) if merged is not None else None
