"""The `.wpreplay` bundle: a recorded session another person can open (#347).

A bundle is the session as JSON, gzipped, under a small envelope that says
what was taken out. Export always masks secrets (the patterns of the log
filter, and the values of secret-named environment variables) and replaces
the project folder and the home folder by ``<project>`` and ``~``, in every
text of the session. On request it also drops the reasoning (thinking steps
and the ``reasoning`` of each step), the token counts and costs, and the
content of the files (their diff lines stay). A summary a model wrote of the
steps (``replay.summary``) is a text of the session like any other: it is
masked on its way out and rebuilt, bounded, on its way in.

Import reads a bundle someone else made, so every field is rebuilt from what
it should be: a text stays a text and is cut to a bound, a number stays a
finite number, an unknown step type becomes ``progress``, and everything else
is dropped. The decompressed size is bounded before it is read. An imported
session gets a new id, so it never replaces one recorded here.

The format carries no provider-specific field: a session from any provider
exports the same way, and one without a thinking trace says so.
"""

from __future__ import annotations

import gzip
import json
import math
import time
import uuid
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from foundation.log_redaction import text_redactor

from .models import (
    Bookmark,
    BookmarkReply,
    Breakpoint,
    BreakpointType,
    FileDiff,
    ReplaySession,
    ReplayStep,
    ReplayStepType,
    SessionSummary,
)

FORMAT = "wpreplay"
VERSION = 1
EXTENSION = ".wpreplay"
MAX_BUNDLE_BYTES = 25 * 1024 * 1024
MAX_JSON_BYTES = 120 * 1024 * 1024
MAX_STEPS = 20_000
MAX_DIFFS = 200
MAX_DIFF_LINES = 2_000
MAX_ITEMS = 500
MAX_TEXT = 200_000
MAX_CONTENT = 2_000_000
MAX_SHORT = 500
MAX_DEPTH = 6
MAX_SUMMARY = 4_000
MAX_REPLIES = 50
IMPORTED_TAG = "imported"

_THINKING = ReplayStepType.AGENT_THINKING


@dataclass(frozen=True)
class ExportOptions:
    strip_reasoning: bool = False
    strip_tokens: bool = False
    include_file_contents: bool = False

    def to_dict(self) -> dict[str, bool]:
        return {
            "strip_reasoning": self.strip_reasoning,
            "strip_tokens": self.strip_tokens,
            "include_file_contents": self.include_file_contents,
        }


class BundleError(ValueError):
    """Not a bundle this version can read."""


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def _path_forms(path: str) -> list[str]:
    """``path`` as it may be written: as given, with ``/`` and with ``\\``."""
    stripped = path.rstrip("/\\")
    if len(stripped) < 2:
        return []
    return sorted(
        {stripped, stripped.replace("\\", "/"), stripped.replace("/", "\\")},
        key=len,
        reverse=True,
    )


class _Masker:
    def __init__(self, project_path: str, home: str) -> None:
        self._swaps = [(form, "<project>") for form in _path_forms(project_path)]
        self._swaps += [(form, "~") for form in _path_forms(home)]
        self._redact = text_redactor()

    def text(self, value: str) -> str:
        for form, replacement in self._swaps:
            value = value.replace(form, replacement)
        return self._redact(value)

    def value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, dict):
            return {self.text(str(k)): self.value(v) for k, v in value.items()}
        return value


def text_masker(
    session: ReplaySession, home: str | None = None
) -> Callable[[str], str]:
    """What masks a text of ``session`` on export, for a text made from it."""
    masker = _Masker(
        session.project_path, home if home is not None else str(Path.home())
    )
    return masker.text


def has_thinking(session: ReplaySession) -> bool:
    """Whether the model left a trace: a thinking step, or a step's reasoning."""
    return any(
        step.step_type == _THINKING or step.reasoning.strip() for step in session.steps
    )


def _strip_step(step: dict[str, Any], options: ExportOptions) -> dict[str, Any]:
    if options.strip_reasoning:
        step["reasoning"] = ""
    if options.strip_tokens:
        for key in ("input_tokens", "output_tokens", "cumulative_tokens"):
            step[key] = 0
        step["cost_usd"] = 0.0
        step["cumulative_cost_usd"] = 0.0
    if not options.include_file_contents:
        for diff in step["file_diffs"]:
            diff["before_content"] = None
            diff["after_content"] = None
    return step


def build_bundle(
    session: ReplaySession,
    options: ExportOptions,
    *,
    home: str | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """The envelope and the session, masked and stripped as ``options`` say."""
    data = session.to_dict()
    for derived in ("file_heatmap", "tool_usage_stats", "token_timeline"):
        data.pop(derived, None)
    steps = [
        _strip_step(step, options)
        for step in data["steps"]
        if not (options.strip_reasoning and step["step_type"] == _THINKING.value)
    ]
    data["steps"] = steps
    data["step_count"] = len(steps)
    if options.strip_tokens:
        data["total_tokens"] = 0
        data["total_cost_usd"] = 0.0
    masker = _Masker(
        session.project_path, home if home is not None else str(Path.home())
    )
    masked = masker.value(data)
    if not has_thinking(session):
        thinking = "none"
    elif options.strip_reasoning:
        thinking = "removed"
    else:
        thinking = "included"
    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": time.time() if now is None else now,
        "redacted": True,
        "options": options.to_dict(),
        "thinking": thinking,
        "session": masked,
    }


def encode(bundle: dict[str, Any]) -> bytes:
    raw = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    return gzip.compress(raw.encode("utf-8"), mtime=0)


def file_name(session: ReplaySession, extension: str = EXTENSION) -> str:
    """A file name from the agent and the date, safe on every OS."""
    stamp = time.strftime("%Y%m%d-%H%M", time.gmtime(session.start_time))
    name = "".join(c if c.isalnum() else "-" for c in session.agent_name.lower())
    name = "-".join(part for part in name.split("-") if part)[:40] or "session"
    return f"replay-{name}-{stamp}{extension}"


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


def decode(data: bytes) -> dict[str, Any]:
    """The bundle in ``data`` (gzipped, or plain JSON), bounded in size."""
    if len(data) > MAX_BUNDLE_BYTES:
        raise BundleError("too_large")
    raw = data
    if data[:2] == b"\x1f\x8b":
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            raw = inflater.decompress(data, MAX_JSON_BYTES + 1)
        except zlib.error as error:
            raise BundleError("unreadable") from error
        if len(raw) > MAX_JSON_BYTES or inflater.unconsumed_tail:
            raise BundleError("too_large")
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise BundleError("unreadable") from error
    if not isinstance(bundle, dict) or bundle.get("format") != FORMAT:
        raise BundleError("not_a_bundle")
    if bundle.get("version") != VERSION:
        raise BundleError("unsupported_version")
    if not isinstance(bundle.get("session"), dict):
        raise BundleError("not_a_bundle")
    return bundle


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _maybe_text(value: Any, limit: int = MAX_TEXT) -> str | None:
    return value[:limit] if isinstance(value, str) else None


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return float(value) if math.isfinite(value) else 0.0


def _count(value: Any) -> int:
    number = _number(value)
    return max(0, int(number)) if abs(number) < 2**53 else 0


def _texts(value: Any, limit: int = MAX_SHORT, items: int = MAX_ITEMS) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item[:limit] for item in value[:items] if isinstance(item, str)]


def _json(value: Any, depth: int = 0) -> Any:
    """A JSON value of bounded depth and size, from plain JSON types only."""
    if isinstance(value, str):
        return value[:MAX_TEXT]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return _number(value)
    if depth >= MAX_DEPTH:
        return None
    if isinstance(value, list):
        return [_json(item, depth + 1) for item in value[:MAX_ITEMS]]
    if isinstance(value, dict):
        items = list(value.items())[:MAX_ITEMS]
        return {str(k)[:MAX_SHORT]: _json(v, depth + 1) for k, v in items}
    return None


def _dicts(value: Any, limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:limit] if isinstance(item, dict)]


def _step_type(value: Any) -> ReplayStepType:
    try:
        return ReplayStepType(value)
    except ValueError:
        return ReplayStepType.PROGRESS


def _diff(data: dict[str, Any]) -> FileDiff:
    lines = data.get("diff_lines")
    return FileDiff(
        file_path=_text(data.get("file_path"), MAX_SHORT),
        operation=_text(data.get("operation"), 20),
        before_content=_maybe_text(data.get("before_content"), MAX_CONTENT),
        after_content=_maybe_text(data.get("after_content"), MAX_CONTENT),
        diff_lines=_texts(lines, MAX_SHORT * 4, MAX_DIFF_LINES)
        if isinstance(lines, list)
        else None,
        line_count_before=_count(data.get("line_count_before")),
        line_count_after=_count(data.get("line_count_after")),
    )


def _step(data: dict[str, Any], position: int) -> ReplayStep:
    tool_input = data.get("tool_input")
    index = data.get("step_index")
    return ReplayStep(
        id=_text(data.get("id"), 64) or uuid.uuid4().hex[:12],
        step_index=_count(index) if isinstance(index, int) else position,
        step_type=_step_type(data.get("step_type")),
        timestamp=_number(data.get("timestamp")),
        duration_ms=_number(data.get("duration_ms")),
        label=_text(data.get("label"), MAX_SHORT),
        description=_text(data.get("description")),
        reasoning=_text(data.get("reasoning")),
        tool_name=_maybe_text(data.get("tool_name"), MAX_SHORT),
        tool_input=_json(tool_input) if isinstance(tool_input, dict) else None,
        tool_output=_maybe_text(data.get("tool_output")),
        file_diffs=[_diff(d) for d in _dicts(data.get("file_diffs"), MAX_DIFFS)],
        input_tokens=_count(data.get("input_tokens")),
        output_tokens=_count(data.get("output_tokens")),
        cumulative_tokens=_count(data.get("cumulative_tokens")),
        cost_usd=_number(data.get("cost_usd")),
        cumulative_cost_usd=_number(data.get("cumulative_cost_usd")),
        decision_node_id=_maybe_text(data.get("decision_node_id"), 64),
        parent_step_id=_maybe_text(data.get("parent_step_id"), 64),
        children_step_ids=_texts(data.get("children_step_ids"), 64),
        options_considered=_texts(data.get("options_considered")),
        chosen_option=_maybe_text(data.get("chosen_option"), MAX_SHORT),
        is_breakpoint=data.get("is_breakpoint") is True,
        breakpoint_id=_maybe_text(data.get("breakpoint_id"), 64),
    )


def _reply(data: dict[str, Any]) -> BookmarkReply:
    return BookmarkReply(
        id=_text(data.get("id"), 64) or uuid.uuid4().hex[:8],
        note=_text(data.get("note"), 4000),
        author=_text(data.get("author"), 100),
        created_at=_number(data.get("created_at")),
    )


def _bookmark(data: dict[str, Any]) -> Bookmark:
    return Bookmark(
        id=_text(data.get("id"), 64) or uuid.uuid4().hex[:8],
        step_index=_count(data.get("step_index")),
        note=_text(data.get("note"), 4000),
        author=_text(data.get("author"), 100),
        created_at=_number(data.get("created_at")),
        replies=[_reply(r) for r in _dicts(data.get("replies"), MAX_REPLIES)],
    )


def _breakpoint(data: dict[str, Any]) -> Breakpoint | None:
    try:
        kind = BreakpointType(data.get("breakpoint_type"))
    except ValueError:
        return None
    return Breakpoint(
        id=_text(data.get("id"), 64) or uuid.uuid4().hex[:8],
        breakpoint_type=kind,
        enabled=data.get("enabled") is not False,
        condition=_text(data.get("condition"), MAX_SHORT),
        description=_text(data.get("description"), MAX_SHORT),
        hit_count=_count(data.get("hit_count")),
    )


def _summary(data: Any) -> SessionSummary | None:
    if not isinstance(data, dict):
        return None
    text = _text(data.get("text"), MAX_SUMMARY)
    if not text.strip():
        return None
    return SessionSummary(
        text=text,
        provider=_text(data.get("provider"), MAX_SHORT),
        model=_text(data.get("model"), MAX_SHORT),
        language="fr" if data.get("language") == "fr" else "en",
        created_at=_number(data.get("created_at")),
    )


def session_from_bundle(bundle: dict[str, Any]) -> ReplaySession:
    """A new local session rebuilt from the bundle's session, field by field."""
    data: dict[str, Any] = bundle["session"]
    end = data.get("end_time")
    steps = _dicts(data.get("steps"), MAX_STEPS)
    tags = [t for t in _texts(data.get("tags"), 50, 50) if t != IMPORTED_TAG]
    breakpoints = [_breakpoint(b) for b in _dicts(data.get("breakpoints"), MAX_ITEMS)]
    return ReplaySession(
        session_id=str(uuid.uuid4()),
        agent_id=_maybe_text(data.get("agent_id"), 64),
        agent_name=_text(data.get("agent_name"), MAX_SHORT),
        agent_role=_text(data.get("agent_role"), MAX_SHORT),
        provider=_text(data.get("provider"), MAX_SHORT),
        model=_text(data.get("model"), MAX_SHORT),
        model_label=_text(data.get("model_label"), MAX_SHORT),
        task_description=_text(data.get("task_description")),
        project_path=_text(data.get("project_path"), MAX_SHORT),
        start_time=_number(data.get("start_time")),
        end_time=_number(end) if isinstance(end, int | float) else None,
        steps=[_step(s, i) for i, s in enumerate(steps)],
        breakpoints=[b for b in breakpoints if b is not None],
        bookmarks=[_bookmark(b) for b in _dicts(data.get("bookmarks"), MAX_ITEMS)],
        summary=_summary(data.get("summary")),
        total_tokens=_count(data.get("total_tokens")),
        total_cost_usd=_number(data.get("total_cost_usd")),
        total_tool_calls=_count(data.get("total_tool_calls")),
        total_file_changes=_count(data.get("total_file_changes")),
        files_touched=_texts(data.get("files_touched")),
        status="completed",
        tags=[IMPORTED_TAG, *tags],
    )
