"""What a session started from, and which files its tools wrote.

At the start of a coder session the worktree may be dirty: the person edited
files between two sessions and did not commit. The agent's commit will carry
those lines, and they are not the agent's. ``session_start`` keeps the hash of
every line that differs from ``HEAD`` then, so the record can give them to
``human``.

The SDK paths (the Claude SDK hook, ``tool_executor`` for the providers
WorkPilot serves itself) also say which files a Write or Edit touched
(``note_tool_write``). A file changed in the commit without one was produced
by a command (a formatter, a generator): still the agent's, noted as such.
A CLI agent goes through neither, and its record simply has no such note.

Nothing here can fail a build: every error is swallowed and logged at debug.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

from .diff import line_hash

logger = logging.getLogger(__name__)

__all__ = [
    "START_FILE",
    "WRITES_FILE",
    "load_start",
    "load_writes",
    "note_tool_write",
    "session_start",
]

START_FILE = "agent_trace_start.json"
WRITES_FILE = "agent_trace_writes.jsonl"
_MEMORY = "memory"
#: Past this the snapshot stops: a dirty tree that large is not hand edits.
_MAX_HUMAN_LINES = 20_000
_MAX_UNTRACKED_BYTES = 256 * 1024
_MAX_WRITES_BYTES = 256 * 1024


def _memory(spec_dir: Path | str) -> Path:
    return Path(spec_dir) / _MEMORY


def _head(project_dir: Path) -> str | None:
    result = run_git(["rev-parse", "HEAD"], cwd=project_dir, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else None


def _dirty_lines(project_dir: Path) -> dict[str, list[str]]:
    """The hashes of the lines that differ from ``HEAD``, per file."""
    human: dict[str, set[str]] = {}
    count = 0
    diff = run_git(
        [
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-U0",
            "HEAD",
        ],
        cwd=project_dir,
        timeout=60,
    )
    path: str | None = None
    for row in diff.stdout.splitlines() if diff.returncode == 0 else []:
        if row.startswith("+++ "):
            target = row[4:].strip()
            path = target[2:] if target.startswith("b/") else None
        elif path and row.startswith("+") and count < _MAX_HUMAN_LINES:
            human.setdefault(path, set()).add(line_hash(row[1:]))
            count += 1
    untracked = run_git(
        ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"],
        cwd=project_dir,
        timeout=30,
    )
    for rel in untracked.stdout.splitlines() if untracked.returncode == 0 else []:
        source = Path(project_dir) / rel
        try:
            if source.is_symlink() or source.stat().st_size > _MAX_UNTRACKED_BYTES:
                continue
            text = source.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line in text.splitlines():
            if count >= _MAX_HUMAN_LINES:
                break
            human.setdefault(rel, set()).add(line_hash(line))
            count += 1
    return {p: sorted(s) for p, s in human.items()}


def session_start(
    spec_dir: Path | str | None,
    project_dir: Path,
    subtask_id: str | None = None,
    session: int | None = None,
) -> str | None:
    """``HEAD`` before the session, after noting what the person left uncommitted.

    The return value is the session's ``commit_before``, so the call replaces
    ``get_latest_commit`` where a coder session starts.
    """
    head = _head(project_dir)
    if spec_dir is None:
        return head
    try:
        memory = _memory(spec_dir)
        memory.mkdir(parents=True, exist_ok=True)
        snapshot = {
            "head": head,
            "at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "subtask_id": subtask_id,
            "session": session,
            "human": _dirty_lines(project_dir),
        }
        (memory / START_FILE).write_text(json.dumps(snapshot), encoding="utf-8")
        (memory / WRITES_FILE).unlink(missing_ok=True)
    except OSError:
        logger.debug("agent trace: no session snapshot", exc_info=True)
    return head


def load_start(spec_dir: Path | str) -> dict:
    try:
        data = json.loads((_memory(spec_dir) / START_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def note_tool_write(spec_dir: Path | str | None, tool: str, file_path: str) -> None:
    """A Write / Edit of ``file_path`` by the session's tools. Never raises."""
    if spec_dir is None or not file_path:
        return
    try:
        target = _memory(spec_dir) / WRITES_FILE
        if target.is_file() and target.stat().st_size >= _MAX_WRITES_BYTES:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"tool": str(tool)[:40], "path": str(file_path)[:1000]})
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        logger.debug("agent trace: write not noted", exc_info=True)


def load_writes(spec_dir: Path | str, project_dir: Path) -> set[str] | None:
    """The repo-relative files the tools wrote this session; None when none noted."""
    try:
        text = (_memory(spec_dir) / WRITES_FILE).read_text(encoding="utf-8")
    except OSError:
        return None
    root = os.path.realpath(project_dir)
    written: set[str] = set()
    for row in text.splitlines():
        try:
            path = str(json.loads(row).get("path") or "")
        except (ValueError, AttributeError):
            continue
        absolute = os.path.realpath(os.path.join(root, path))
        if absolute.startswith(root + os.sep):
            written.add(os.path.relpath(absolute, root).replace("\\", "/"))
    return written or None
