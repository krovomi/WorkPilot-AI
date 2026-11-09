"""What the guardrails did, and what the person approved.

Two files in the main project's ``.workpilot/`` (both refused to agents by
``path_guard``, so an agent cannot approve its own action):

* ``guardrail-log.jsonl``: one line per triggered rule outside ``allow``
  (warn, deny, pending approval, approved), for the activity view of
  Settings > Guardrails: counts per rule, the last events, and the "42 calls
  blocked in 10 minutes" diagnostic of a rule that stops every agent.
* ``guardrail-approvals.json``: the person's answers to ``require_approval``.
  An approval names the rules and the exact target (a file, or the hash of a
  command) and lets **one** identical call through, within a day.

Commands are stored redacted and cut short: a log is no place for a token.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .guardrails import GuardrailDecision, relative_path

LOG_NAME = "guardrail-log.jsonl"
APPROVALS_NAME = "guardrail-approvals.json"
MAX_LOG_LINES = 5000
APPROVAL_TTL = timedelta(hours=24)
_SUMMARY_CHARS = 200


def _dir(project: Path) -> Path:
    return Path(project) / ".workpilot"


def _now() -> datetime:
    return datetime.now(tz=UTC)


# A value after a secret-looking name, and anything shaped like a token. The
# security layer may not import foundation's redaction (import contracts), so
# the log keeps its own: the summary is for a person to recognise the call, the
# approval key is the hash of the whole command.
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)((?:token|secret|password|passwd|pwd|api[_-]?key|authorization|bearer|"
    r"credential|private[_-]?key)[\w-]*[\"']?\s*[:=]?\s*(?:bearer\s+)?)([^\s\"']+)"
)
_TOKEN_SHAPE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|[A-Za-z0-9_+/=-]{40,})"
)


def _redact(text: str) -> str:
    text = _SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + "***", text)
    return _TOKEN_SHAPE.sub("***", text)


def target_of(
    tool_name: str, tool_input: dict[str, Any], root: Path | None
) -> dict[str, str]:
    """What a call acts on: a repo-relative path, or a command and its hash."""
    if tool_name == "Bash":
        command = str(tool_input.get("command", ""))
        digest = hashlib.sha256(command.encode("utf-8")).hexdigest()[:16]
        summary = _redact(command)[:_SUMMARY_CHARS]
        return {"kind": "command", "key": f"Bash:{digest}", "summary": summary}
    raw = str(
        tool_input.get("file_path")
        or tool_input.get("notebook_path")
        or tool_input.get("path")
        or ""
    )
    path = relative_path(raw, root)
    return {"kind": "file", "key": f"file:{path}", "summary": path}


def _task_of(root: Path | None) -> str | None:
    if root is None:
        return None
    parts = Path(root).parts
    for index, part in enumerate(parts[:-1]):
        if part == "tasks" and index > 0 and parts[index - 1] == "worktrees":
            return parts[index + 1]
    return None


def record(
    project: Path,
    decision: GuardrailDecision,
    tool_name: str,
    target: dict[str, str],
    root: Path | None = None,
    outcome: str | None = None,
) -> None:
    """Append one event; a log that cannot be written never blocks the agent."""
    event = {
        "id": uuid.uuid4().hex[:12],
        "at": _now().isoformat(),
        "action": decision.action.value,
        "outcome": outcome or decision.action.value,
        "rules": [r.id for r in decision.triggered],
        "tool": tool_name,
        "target": target,
        "details": {k: v[:10] for k, v in decision.details.items()},
        "task": _task_of(root),
        "message": _redact(decision.message)[:1000],
    }
    path = _dir(project) / LOG_NAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if outcome == "pending" and _pending_exists(path, event):
            return
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        _trim(path)
    except OSError:
        return


def _pending_exists(path: Path, event: dict[str, Any]) -> bool:
    """An agent retrying the same call does not stack the same request."""
    key = (tuple(event["rules"]), event["target"]["key"])
    answered = _answered_ids(path.parent)
    for line in _tail(path, 200):
        if (
            line.get("outcome") == "pending"
            and (tuple(line.get("rules", [])), line.get("target", {}).get("key")) == key
        ):
            if line.get("id") not in answered:
                return True
    return False


def _tail(path: Path, count: int) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-count:]
    except OSError:
        return []
    events = []
    for line in lines:
        with contextlib.suppress(ValueError):
            value = json.loads(line)
            if isinstance(value, dict):
                events.append(value)
    return events


def _trim(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    if len(lines) > MAX_LOG_LINES:
        _atomic_write(path, "\n".join(lines[-MAX_LOG_LINES:]) + "\n")


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except OSError:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _load_approvals(project: Path) -> list[dict[str, Any]]:
    path = _dir(project) / APPROVALS_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return (
        [a for a in data.get("approvals", []) if isinstance(a, dict)]
        if isinstance(data, dict)
        else []
    )


def _save_approvals(project: Path, approvals: list[dict[str, Any]]) -> None:
    path = _dir(project) / APPROVALS_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(
        path, json.dumps({"approvals": approvals}, indent=2, ensure_ascii=False) + "\n"
    )


def _answered_ids(directory: Path) -> set[str]:
    return {
        str(a.get("request"))
        for a in _load_approvals(directory.parent)
        if a.get("request")
    }


def _alive(approval: dict[str, Any]) -> bool:
    try:
        expires = datetime.fromisoformat(str(approval.get("expires_at")))
    except ValueError:
        return False
    return expires > _now()


def consume_approval(
    project: Path, decision: GuardrailDecision, target: dict[str, str]
) -> bool:
    """Whether the person approved this call; an approval is used once."""
    approvals = _load_approvals(project)
    wanted = {r.id for r in decision.triggered if r.action.value == "require_approval"}
    for approval in approvals:
        if (
            approval.get("decision") != "approved"
            or approval.get("used_at")
            or not _alive(approval)
        ):
            continue
        if approval.get("target") != target["key"]:
            continue
        if not wanted <= set(approval.get("rules", [])):
            continue
        approval["used_at"] = _now().isoformat()
        try:
            _save_approvals(project, approvals)
        except OSError:
            return False  # an approval that cannot be marked used is not used
        return True
    return False


def answer(
    project: Path, request_id: str, approved: bool, by: str = "user"
) -> dict[str, Any] | None:
    """The person's answer to a pending request; ``None`` if there is no such request."""
    request = next(
        (
            e
            for e in _tail(_dir(project) / LOG_NAME, MAX_LOG_LINES)
            if e.get("id") == request_id and e.get("outcome") == "pending"
        ),
        None,
    )
    if request is None:
        return None
    approvals = [
        a for a in _load_approvals(project) if _alive(a)
    ]  # expired ones are pruned
    entry = {
        "request": request_id,
        "decision": "approved" if approved else "refused",
        "rules": request.get("rules", []),
        "target": request.get("target", {}).get("key"),
        "summary": request.get("target", {}).get("summary"),
        "by": by,
        "at": _now().isoformat(),
        "expires_at": (_now() + APPROVAL_TTL).isoformat(),
        "used_at": None,
    }
    approvals = [a for a in approvals if a.get("request") != request_id] + [entry]
    _save_approvals(project, approvals)
    return entry


def activity(project: Path, limit: int = 100) -> dict[str, Any]:
    """The activity view: last events, open requests, counts, and the noisy-rule diagnostic."""
    events = _tail(_dir(project) / LOG_NAME, MAX_LOG_LINES)
    answered = {
        str(a.get("request")): a.get("decision") for a in _load_approvals(project)
    }
    # A request older than an approval's lifetime is stale: the build that
    # asked has moved on, and an answer to it would outlive its own window.
    fresh = (_now() - APPROVAL_TTL).isoformat()
    pending = [
        e
        for e in events
        if e.get("outcome") == "pending"
        and e.get("id") not in answered
        and str(e.get("at", "")) >= fresh
    ]
    counts: dict[str, dict[str, int]] = {}
    for event in events:
        for rule in event.get("rules", []):
            per = counts.setdefault(rule, {})
            per[event.get("outcome", "?")] = per.get(event.get("outcome", "?"), 0) + 1
    cutoff = (_now() - timedelta(minutes=10)).isoformat()
    recent_blocks = sum(
        1
        for e in events
        if e.get("outcome") in ("deny", "pending") and str(e.get("at", "")) >= cutoff
    )
    return {
        "events": list(reversed(events[-limit:])),
        "pending": list(reversed(pending[-50:])),
        "counts": counts,
        "blockedLast10Min": recent_blocks,
        "answers": answered,
        "generatedAt": time.time(),
    }
