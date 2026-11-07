"""How much of the task's diff the records attribute, file by file.

The records describe each session's commit range. What a reviewer wants is
the final diff: of the lines the task adds against its base, how many an
agent wrote, with which model, how many the person did, and how many nothing
accounts for. Each recorded range is looked for in the file at ``HEAD`` by
its ``content_hash`` (at its place first, then anywhere: a rebase or a
reformat above it moves it). A range that is no longer there, changed in
review or rewritten by a later commit, counts for nobody: its lines are
``unknown`` rather than guessed (the spec leaves rebases open).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .diff import added_ranges, file_lines, range_hash
from .record import METADATA_KEY, read_records

logger = logging.getLogger(__name__)

__all__ = ["SUMMARY_FILE", "attribution_line", "summarize", "write_summary"]

SUMMARY_FILE = "agent-trace-summary.json"
_MAX_SCAN_LINES = 20_000


def _find(content: list[str], start: int, length: int, digest: str) -> int | None:
    """The 1-based line where a range of ``length`` lines hashing to ``digest`` is."""
    if (
        0 < start <= len(content)
        and range_hash(content[start - 1 : start - 1 + length]) == digest
    ):
        return start
    if len(content) > _MAX_SCAN_LINES:
        return None
    for i in range(0, len(content) - length + 1):
        if range_hash(content[i : i + length]) == digest:
            return i + 1
    return None


def _base_of(records: list[dict]) -> str | None:
    for record in records:
        base = (record.get("metadata") or {}).get(METADATA_KEY, {}).get("base")
        if isinstance(base, str) and base:
            return base
    return None


def summarize(
    project_dir: Path, spec_dir: Path, base: str | None = None
) -> dict | None:
    """``{"files": {path: {added, ai, human, unknown}}, "totals", "models"}``.

    ``base`` defaults to the first record's base (where the task started).
    None when there is no record or git cannot answer.
    """
    records = read_records(spec_dir)
    base = base or _base_of(records)
    if not records or not base:
        return None
    try:
        final = added_ranges(project_dir, base, "HEAD")
    except OSError:
        logger.debug("agent trace: no summary", exc_info=True)
        return None
    files: dict[str, dict] = {}
    models: dict[str, int] = {}
    for path, lines in final.items():
        content = file_lines(project_dir, "HEAD", path) or []
        owner: dict[int, tuple[str, str | None]] = {}
        # Newest record first: a later session's rewrite of a line wins.
        for record in reversed(records):
            for entry in record.get("files") or []:
                if entry.get("path") != path:
                    continue
                for conversation in entry.get("conversations") or []:
                    contributor = conversation.get("contributor") or {}
                    kind = str(contributor.get("type") or "unknown")
                    model = contributor.get("model_id")
                    for rng in conversation.get("ranges") or []:
                        start, end = rng.get("start_line"), rng.get("end_line")
                        digest = rng.get("content_hash")
                        if not (
                            isinstance(start, int) and isinstance(end, int) and digest
                        ):
                            continue
                        found = _find(content, start, end - start + 1, str(digest))
                        if found is None:
                            continue
                        for number in range(found, found + end - start + 1):
                            owner.setdefault(number, (kind, model))
        counts = {"added": len(lines), "ai": 0, "human": 0, "unknown": 0}
        for number in lines:
            kind, model = owner.get(number, ("unknown", None))
            kind = kind if kind in ("ai", "human") else "unknown"
            counts[kind] += 1
            if kind == "ai" and model:
                models[str(model)] = models.get(str(model), 0) + 1
        files[path] = counts
    totals = {
        k: sum(f[k] for f in files.values())
        for k in ("added", "ai", "human", "unknown")
    }
    return {"base": base, "files": files, "totals": totals, "models": models}


def write_summary(
    project_dir: Path, spec_dir: Path, *copies: Path | None
) -> dict | None:
    """Write ``agent-trace-summary.json`` for the desktop's diff view. Never raises."""
    try:
        summary = summarize(project_dir, spec_dir)
    except (OSError, ValueError, UnicodeError):
        logger.debug("agent trace: no summary", exc_info=True)
        return None
    if summary is None:
        return None
    for target in {Path(spec_dir), *(Path(c) for c in copies if c)}:
        try:
            (target / SUMMARY_FILE).write_text(json.dumps(summary), encoding="utf-8")
        except OSError:
            logger.debug(
                "agent trace: summary not written in %s", target, exc_info=True
            )
    return summary


def attribution_line(summary: dict | None) -> str:
    """One Markdown line for a PR body, ``""`` when nothing is attributed."""
    if not summary:
        return ""
    totals = summary.get("totals") or {}
    added = int(totals.get("added") or 0)
    ai = int(totals.get("ai") or 0)
    if added <= 0 or ai <= 0:
        return ""
    share = round(100 * ai / added)
    models = sorted((summary.get("models") or {}).items(), key=lambda kv: -kv[1])
    named = ", ".join(f"`{m}`" for m, _ in models[:3])
    line = f"**AI attribution** ([Agent Trace](https://github.com/cursor/agent-trace)): {share}% of the {added} added lines come from the agent"
    if named:
        line += f" ({named})"
    human = int(totals.get("human") or 0)
    if human:
        line += f", {round(100 * human / added)}% from the person"
    return line + "."
