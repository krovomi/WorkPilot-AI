"""The policy's audit trail: every decision it took, exportable (#353, lot 2).

One JSON line per decision in ``<project>/.workpilot/policy-audit.jsonl`` of the
**main** project: a write or command refused, sent for review, approved or let
through with a warning, the policy found invalid, agents stopped outside their
hours or past their token budget. Each line says who ran the agent, when, which
task, tool and file, the decision, its rules and why, and the provider and model
when the caller knows them. Settings > Guardrails shows the last ones and
exports them as CSV or JSON for compliance.

Why not ``audit_trail/`` (the hash-chained trail)? Its chain forbids trimming,
so it grows without bound and is loaded whole on every append: too heavy for a
hook that runs before each tool call, and out of the security layer's reach
(``tests/test_import_contracts.py``). This file is bounded instead.

The file is written only through a path resolved inside the project:
``.workpilot`` or the log itself as a symbolic link is refused (an agent's
link must not turn the trail into a write elsewhere), and the file is opened
without following links where the platform can. Like the guardrail log, it is
one of the files no agent may write (``path_guard.PROTECTED_CONFIG_NAMES``).
A trail that cannot be written never blocks the agent: the decision itself
still applies.
"""

from __future__ import annotations

import contextlib
import getpass
import json
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .guardrail_ledger import _atomic_write
from .guardrail_ledger import _redact as redact

AUDIT_NAME = "policy-audit.jsonl"
#: Past this size the oldest lines go; what is kept is read back for the panel.
MAX_BYTES = 4 * 1024 * 1024
KEEP_LINES = 10_000
_REASON_CHARS = 500
_FIELD_CHARS = 300

#: The decisions a line can carry: a closed list, read by the panel and the export.
DECISIONS = frozenset(
    {
        "deny",
        "review",
        "approved",
        "warn",
        "outside_hours",
        "budget_exceeded",
        "invalid_policy",
    }
)
_OWN_WORDS = frozenset({"outside_hours", "budget_exceeded"})
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._:/@+-]{1,80}$")


def _short(value: Any, limit: int = _FIELD_CHARS) -> str | None:
    if value is None or value == "":
        return None
    return redact(str(value))[:limit]


def _name(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if _SAFE_NAME.match(text) else None


def _user() -> str | None:
    try:
        return _name(getpass.getuser())
    except (OSError, KeyError, ImportError):
        return None


def log_path(project: Path, create: bool = False) -> Path | None:
    """The trail's path inside ``project``, or ``None`` if a link would move it."""
    try:
        root = Path(project).resolve()
        folder = root / ".workpilot"
        if folder.is_symlink():
            return None
        if create:
            folder.mkdir(parents=True, exist_ok=True)
        if not folder.is_dir() or folder.is_symlink():
            return None
        path = folder / AUDIT_NAME
        if path.is_symlink():
            return None
        path.resolve().relative_to(root)
    except (OSError, ValueError):
        return None
    return path


def record(
    project: Path,
    *,
    decision: str,
    tool: str | None = None,
    target: dict[str, str] | None = None,
    rules: list[str] | None = None,
    reason: str = "",
    task: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Append one decision; the event written, or ``None`` when it could not be."""
    if decision not in DECISIONS:
        raise ValueError(f"unknown policy decision {decision!r}")
    target = target or {}
    # The hours and the budget are written by WorkPilot from numbers and the
    # schedule (the redaction would mangle "tokens in the last hour"); any
    # other reason may quote what the agent sent.
    if decision in _OWN_WORDS:
        why = str(reason)[:_REASON_CHARS] or None
    else:
        why = _short(reason, _REASON_CHARS)
    event = {
        "id": uuid.uuid4().hex[:12],
        "at": (now or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "user": _user(),
        "task": _name(task),
        "tool": _name(tool),
        "targetKind": target.get("kind")
        if target.get("kind") in ("file", "command")
        else None,
        "target": _short(target.get("summary")),
        "decision": decision,
        "rules": [str(r)[:120] for r in (rules or [])[:20] if r],
        "reason": why,
        "provider": _name(provider or os.environ.get("SELECTED_LLM_PROVIDER")),
        "model": _name(model),
    }
    path = log_path(project, create=True)
    if path is None:
        return None
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        _trim(path)
    except OSError:
        return None
    return event


def _trim(path: Path) -> None:
    if path.stat().st_size <= MAX_BYTES:
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    _atomic_write(path, "\n".join(lines[-KEEP_LINES:]) + "\n")


def read_events(project: Path, limit: int = KEEP_LINES) -> list[dict[str, Any]]:
    """The last ``limit`` decisions, newest first; none when the trail is unreadable."""
    path = log_path(project)
    if limit <= 0 or path is None or not path.is_file():
        return []
    try:
        if path.stat().st_size > MAX_BYTES * 2:
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    events = []
    for line in lines[-min(limit, KEEP_LINES) :]:
        with contextlib.suppress(ValueError):
            value = json.loads(line)
            if isinstance(value, dict) and value.get("decision") in DECISIONS:
                events.append(value)
    events.reverse()
    return events


def task_of(root: Path | None) -> str | None:
    """The task a worktree belongs to (``.../worktrees/tasks/<task>``)."""
    if root is None:
        return None
    parts = Path(root).parts
    for index, part in enumerate(parts[:-1]):
        if part == "tasks" and index > 0 and parts[index - 1] == "worktrees":
            return parts[index + 1]
    return None


__all__ = [
    "AUDIT_NAME",
    "DECISIONS",
    "KEEP_LINES",
    "MAX_BYTES",
    "log_path",
    "read_events",
    "record",
    "task_of",
]
