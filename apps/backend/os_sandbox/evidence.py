"""What a task's sandbox was, kept in its spec directory for the approval tier.

The ``SANDBOX_STATUS`` event goes to the card and is gone; the approvals
engine (``apps/backend/approvals``) judges the task's pull request later, in
another process. So each session's sandbox kind and each host the sandbox
refused are written to ``sandbox_evidence.json``, in every copy of the spec
directory (the worktree's and the main project's, as the pause is).

A record that cannot be written is lost, never fatal: the tier then reads the
sandbox as unknown, and an unknown fact satisfies no comparison.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

EVIDENCE_FILE = "sandbox_evidence.json"
MAX_SESSIONS = 50
MAX_HOSTS = 50

MICROVM = "microvm"
OS = "os"
NONE = "none"
KINDS = (MICROVM, OS, NONE)
_HOST = re.compile(r"^[A-Za-z0-9._-]{1,253}(?::[0-9]{1,5})?$")


def kind_of(state: str, backend: str | None) -> str:
    """microvm, os (WorkPilot's OS sandbox or the provider's own) or none."""
    if state == "isolated":
        return MICROVM if backend == MICROVM else OS
    if state == "delegated":
        return OS
    return NONE


def _spec_dirs(spec_dir: Path | str) -> list[Path]:
    from foundation.pause_state import task_spec_dirs

    return task_spec_dirs(Path(spec_dir))


def _load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(path: Path, data: dict[str, Any]) -> None:
    if path.is_symlink():
        return
    partial = path.with_suffix(".json.partial")
    try:
        partial.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(partial, path)
    except OSError:
        # A lost record reads as an unknown sandbox: never a weaker tier.
        pass


def record_session(
    spec_dir: Path | str | None, provider: str, state: str, backend: str | None
) -> None:
    """One session's sandbox, as first reported."""
    if not spec_dir:
        return
    entry = {
        "provider": str(provider)[:64],
        "kind": kind_of(state, backend),
        "state": str(state)[:32],
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    for folder in _spec_dirs(spec_dir):
        path = folder / EVIDENCE_FILE
        data = _load(path)
        sessions = data.get("sessions")
        sessions = sessions if isinstance(sessions, list) else []
        data["sessions"] = [*sessions, entry][-MAX_SESSIONS:]
        _save(path, data)


def record_refused(spec_dir: Path | str | None, hosts: list[str]) -> None:
    """Hosts the sandbox refused to a command of the task, once each."""
    if not spec_dir or not hosts:
        return
    for folder in _spec_dirs(spec_dir):
        path = folder / EVIDENCE_FILE
        data = _load(path)
        known = data.get("blockedHosts")
        known = (
            [h for h in known if isinstance(h, str)] if isinstance(known, list) else []
        )
        for host in hosts:
            if host not in known and _HOST.match(str(host)):
                known.append(str(host))
        data["blockedHosts"] = known[:MAX_HOSTS]
        _save(path, data)


def read_evidence(spec_dir: Path | str) -> tuple[str | None, list[str] | None]:
    """The task's sandbox (the weakest of its sessions) and the hosts refused.

    ``(None, None)`` when nothing was recorded or the file cannot be read.
    """
    data = _load(Path(spec_dir) / EVIDENCE_FILE)
    if not data:
        return None, None
    sessions = data.get("sessions")
    kinds = {
        s.get("kind")
        for s in (sessions if isinstance(sessions, list) else [])
        if isinstance(s, dict) and s.get("kind") in KINDS
    }
    sandbox = next((k for k in (NONE, OS, MICROVM) if k in kinds), None)
    hosts = data.get("blockedHosts")
    blocked = (
        [h for h in hosts if isinstance(h, str) and _HOST.match(h)][:MAX_HOSTS]
        if isinstance(hosts, list)
        else []
    )
    return sandbox, blocked


__all__ = [
    "EVIDENCE_FILE",
    "KINDS",
    "kind_of",
    "read_evidence",
    "record_refused",
    "record_session",
]
