"""The backstop behind "do not open the original": a `Read` of it is refused.

The prompt tells every agent that an attachment marked redacted or withheld
must not be opened, and names the masked copy to use instead. A prompt is a
request, though, and `Read` is the one tool that turns an image into pixels a
Claude model sees — so the preflight's decision is also enforced where the
tool call happens, like the write-path guard next to it in `create_client`.

The other providers read files through `ToolExecutor.read_file`, which decodes
UTF-8 text and cannot hand an image to a model at all.

It denies and never allows: every other `Read` gets no opinion from here, and
the record is re-read on each call that targets the spec directory, because a
build that re-runs the preflight may withhold a file the previous one did not.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .preflight import load_result

GUARDED_STATUSES = ("redacted", "withheld")


def _resolved(path: Path) -> Path | None:
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return None


def guarded_originals(spec_dir: Path) -> dict[Path, str]:
    """Resolved original path -> status, for every image agents must not open."""
    result = load_result(spec_dir)
    if result is None:
        return {}
    guarded: dict[Path, str] = {}
    for doc in result.documents:
        if doc.status in GUARDED_STATUSES and doc.path:
            resolved = _resolved(spec_dir / doc.path)
            if resolved is not None:
                guarded[resolved] = doc.status
    return guarded


def make_read_guard_hook(spec_dir: Path | str | None):
    """A PreToolUse hook refusing `Read` on a withheld or redacted original."""
    root = _resolved(Path(spec_dir)) if spec_dir else None

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        if root is None or input_data.get("tool_name") != "Read":
            return {}
        tool_input = input_data.get("tool_input")
        raw = tool_input.get("file_path") if isinstance(tool_input, dict) else None
        if not raw:
            return {}
        target = _resolved(Path(str(raw)).expanduser())
        if target is None or not target.is_relative_to(root):
            return {}
        status = guarded_originals(root).get(target)
        if status is None:
            return {}
        reason = (
            "it shows a secret; open the masked copy named in the Task "
            "attachments section instead"
            if status == "redacted"
            else "it was withheld from agents (a secret that could not be masked, "
            "or text flagged as a prompt injection)"
        )
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Refusing to read '{raw}': {reason}.",
            }
        }

    return _hook
