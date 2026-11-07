"""One Agent Trace record per coder session that committed (killer feature F3).

`Agent Trace <https://github.com/cursor/agent-trace>`_ (v0.1, RFC, CC BY 4.0)
lists, per file, conversations and the line ranges they wrote, each with a
contributor (``ai``, ``human``, ``mixed``, ``unknown``) and a ``model_id`` in
``provider/model`` form. WorkPilot writes one record per session's commit
range into ``<spec>/agent-trace.jsonl``, append-only and capped like the
watermark ledger, and never lets an error here fail a build.

- The ranges come from git (``diff.added_ranges``), so every provider is
  covered, CLI agents included.
- Lines the person left uncommitted before the session (``session_start``)
  are ``human``, the rest ``ai``.
- ``version`` is ``"0.1"``: the schema's pattern is ``^[0-9]+\\.[0-9]+$``,
  although the spec's appendix example writes ``"0.1.0"``.
- No prompt and no code goes in a record: hashes, paths, line numbers and the
  model's name only. The conversation ``url`` is left out.
- WorkPilot's own fields live under ``metadata["ai.workpilot"]``.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .diff import added_ranges, file_lines, line_hash, range_hash, spans
from .session import load_start, load_writes

logger = logging.getLogger(__name__)

__all__ = [
    "SPEC_VERSION",
    "TRACE_FILE",
    "build_record",
    "read_records",
    "record_session",
]

TRACE_FILE = "agent-trace.jsonl"
SPEC_VERSION = "0.1"
METADATA_KEY = "ai.workpilot"
_MAX_TRACE_BYTES = 2 * 1024 * 1024
_MAX_FILES = 500


def _contributor_runs(
    lines: set[int], content: list[str], human: set[str]
) -> dict[str, set[int]]:
    """Split the added lines between ``human`` (left by the person) and ``ai``."""
    out: dict[str, set[int]] = {"ai": set(), "human": set()}
    for number in lines:
        text = content[number - 1] if 0 < number <= len(content) else ""
        kind = "human" if human and line_hash(text) in human else "ai"
        out[kind].add(number)
    return out


def _ranges(lines: set[int], content: list[str]) -> list[dict]:
    return [
        {
            "start_line": start,
            "end_line": end,
            "content_hash": range_hash(content[start - 1 : end]),
        }
        for start, end in spans(lines)
    ]


def build_record(
    project_dir: Path,
    spec_dir: Path,
    *,
    base: str,
    head: str,
    model_id: str | None,
    subtask_id: str | None = None,
    session: int | None = None,
) -> dict | None:
    """The record for ``base..head``, or None when it added no line.

    Raises ``OSError`` when git cannot answer.
    """
    added = added_ranges(project_dir, base, head)
    if not added:
        return None
    start = load_start(spec_dir)
    human_by_file: dict = start.get("human") if start.get("head") == base else {}
    written = load_writes(spec_dir, project_dir)
    files: list[dict] = []
    by_command: list[str] = []
    for path in sorted(added)[:_MAX_FILES]:
        content = file_lines(project_dir, head, path)
        if content is None:
            continue
        human = set((human_by_file or {}).get(path) or [])
        runs = _contributor_runs(added[path], content, human)
        conversations = []
        if runs["ai"]:
            ai: dict = {"type": "ai"}
            if model_id:
                ai["model_id"] = model_id[:250]
            conversations.append(
                {"contributor": ai, "ranges": _ranges(runs["ai"], content)}
            )
            if written is not None and path not in written:
                by_command.append(path)
        if runs["human"]:
            conversations.append(
                {
                    "contributor": {"type": "human"},
                    "ranges": _ranges(runs["human"], content),
                }
            )
        files.append({"path": path, "conversations": conversations})
    if not files:
        return None
    if start.get("head") == base:
        subtask_id = subtask_id or start.get("subtask_id")
        session = session if session is not None else start.get("session")
    workpilot: dict = {"spec": Path(spec_dir).name, "base": base}
    if subtask_id:
        workpilot["subtask_id"] = subtask_id
    if session is not None:
        workpilot["session"] = session
    if by_command:
        # Changed in the commit without a Write/Edit of the session's tools:
        # produced by a command the agent ran (formatter, generator).
        workpilot["post_processing_files"] = by_command[:200]
    return {
        "version": SPEC_VERSION,
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vcs": {"type": "git", "revision": head},
        "tool": {"name": "workpilot"},
        "files": files,
        "metadata": {METADATA_KEY: workpilot},
    }


def _append(spec_dir: Path, record: dict) -> bool:
    target = Path(spec_dir) / TRACE_FILE
    try:
        if target.is_file() and target.stat().st_size >= _MAX_TRACE_BYTES:
            logger.debug("agent trace: %s is full", target)
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        return True
    except OSError:
        logger.debug("agent trace: could not append to %s", target, exc_info=True)
        return False


def record_session(
    project_dir: Path,
    spec_dir: Path,
    *,
    base: str | None,
    head: str | None,
    model_id: str | None,
    subtask_id: str | None = None,
    session: int | None = None,
    copies: tuple[Path | None, ...] = (),
) -> dict | None:
    """Build and append the session's record (in each spec copy). Never raises."""
    if not base or not head or base == head:
        return None
    try:
        record = build_record(
            project_dir,
            spec_dir,
            base=base,
            head=head,
            model_id=model_id,
            subtask_id=subtask_id,
            session=session,
        )
    except (OSError, ValueError, UnicodeError):
        logger.debug("agent trace: no record for %s..%s", base, head, exc_info=True)
        return None
    if record is None:
        return None
    for target in {Path(spec_dir), *(Path(c) for c in copies if c)}:
        _append(target, record)
    return record


def read_records(spec_dir: Path | str) -> list[dict]:
    """Every record of the spec, oldest first; a malformed line is skipped."""
    try:
        text = (Path(spec_dir) / TRACE_FILE).read_text(encoding="utf-8")
    except OSError:
        return []
    out: list[dict] = []
    for row in text.splitlines():
        try:
            item = json.loads(row)
        except ValueError:
            continue
        if isinstance(item, dict) and isinstance(item.get("files"), list):
            out.append(item)
    return out
