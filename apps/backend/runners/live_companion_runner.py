#!/usr/bin/env python3
"""
Live Companion Runner

Runs incremental code analysis on file changes detected by the Electron file
watcher (``apps/frontend/src/main/live-companion-service.ts``), batched.

Stdout protocol: one ``LIVE_COMPANION_EVENT:{json}`` line per event:

- ``complete``: ``data.suggestions`` (may be empty), ``data.files_analyzed``,
  and ``data.errors`` for the files the provider could not analyze;
- ``error``: nothing could be analyzed; ``data`` is the redacted error detail
  (``message``, ``code``…) the page shows.

The model is the selected provider's default unless ``--model`` names one.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

# A batch past this many files only analyzes the most recent ones: a branch
# switch or a formatter run would otherwise spend one call per file.
MAX_FILES_PER_BATCH = 8


def emit_event(event_type: str, data: Any = None, message: str = "") -> None:
    """Emit a structured event to stdout for frontend consumption."""
    event: dict[str, Any] = {"type": event_type}
    if data is not None:
        event["data"] = data
    if message:
        event["message"] = message
    print(
        f"LIVE_COMPANION_EVENT:{json.dumps(event, default=str, ensure_ascii=False)}",
        flush=True,
    )


def _error_detail(exc: Exception) -> dict[str, Any]:
    from live_companion.analyzer import AnalysisError

    if isinstance(exc, AnalysisError):
        return dict(exc.detail)
    return {"message": f"{type(exc).__name__}: {exc}", "code": "runner_error"}


async def analyze_events(analyzer, events: list) -> dict[str, Any]:
    """Analyze each event; collect suggestions and per-file errors."""
    suggestions: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    analyzed = 0
    for event in events:
        try:
            found = await analyzer.analyze_change(event)
        except Exception as exc:  # noqa: BLE001 — one file's failure is reported, the batch goes on
            errors.append({**_error_detail(exc), "file_path": event.file_path})
            continue
        analyzed += 1
        suggestions.extend(s.to_dict() for s in found)
    return {"suggestions": suggestions, "files_analyzed": analyzed, "errors": errors}


def _finish(result: dict[str, Any], attempted: int) -> int:
    if attempted and not result["files_analyzed"] and result["errors"]:
        detail = result["errors"][-1]
        emit_event("error", data=detail, message=str(detail.get("message") or ""))
        return 1
    emit_event("complete", data=result)
    return 0


def _make_analyzer(args: argparse.Namespace):
    from live_companion.analyzer import IncrementalAnalyzer

    return IncrementalAnalyzer(
        project_dir=args.project_dir,
        model=args.model or None,
        thinking_level=args.thinking_level,
        min_confidence=args.min_confidence,
        max_per_file=args.max_per_file,
        language=args.language,
    )


async def run_change(args: argparse.Namespace) -> int:
    from live_companion.types import FileChangeEvent

    event = FileChangeEvent(
        file_path=args.file_path, change_type=args.change_type, diff=args.diff
    )
    result = await analyze_events(_make_analyzer(args), [event])
    return _finish(result, 1)


def _read_changes(source: str) -> str:
    """The JSON batch: from stdin when `source` is ``-`` (what the app sends,
    so no diff of the user's code sits in a shared temp folder), else a file."""
    if source == "-":
        return sys.stdin.buffer.read().decode("utf-8")
    path = Path(source)
    if not path.is_file():
        raise FileNotFoundError(source)
    return path.read_text(encoding="utf-8")


async def run_batch(args: argparse.Namespace) -> int:
    from live_companion.types import FileChangeEvent

    try:
        raw = json.loads(_read_changes(args.changes_file))
    except FileNotFoundError:
        emit_event(
            "error",
            data={"message": "Changes file not found.", "code": "changes_missing"},
        )
        return 1
    except (OSError, ValueError) as exc:
        emit_event(
            "error",
            data={
                "message": f"Unreadable changes: {exc}",
                "code": "changes_invalid",
            },
        )
        return 1
    if not isinstance(raw, dict):
        emit_event(
            "error",
            data={
                "message": "Changes must be a JSON object.",
                "code": "changes_invalid",
            },
        )
        return 1

    events = [
        FileChangeEvent.from_dict(change)
        for change in raw.get("changes", [])
        if isinstance(change, dict) and change.get("file_path")
    ]
    # The last change of each file is the one to read; keep the newest files.
    latest: dict[str, Any] = {}
    for event in events:
        latest.pop(event.file_path, None)
        latest[event.file_path] = event
    to_analyze = [
        e for e in latest.values() if e.change_type != "deleted" and e.diff.strip()
    ][-MAX_FILES_PER_BATCH:]

    result = await analyze_events(_make_analyzer(args), to_analyze)
    result["files_skipped"] = len(latest) - len(to_analyze)
    return _finish(result, len(to_analyze))


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project-dir", required=True, help="Project directory")
    parser.add_argument(
        "--model", default="", help="Model id; empty = the provider's default"
    )
    parser.add_argument("--thinking-level", default="low", help="Thinking level")
    parser.add_argument("--min-confidence", type=float, default=0.5)
    parser.add_argument("--max-per-file", type=int, default=5)
    parser.add_argument(
        "--language", default="en", help="Language of the suggestions (en, fr)"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Live Companion Runner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    change_parser = subparsers.add_parser(
        "analyze-change", help="Analyze a single file change"
    )
    _add_common(change_parser)
    change_parser.add_argument("--file-path", required=True, help="Changed file path")
    change_parser.add_argument(
        "--change-type",
        required=True,
        choices=["created", "modified", "deleted", "renamed"],
        help="Type of change",
    )
    change_parser.add_argument("--diff", default="", help="File diff content")

    batch_parser = subparsers.add_parser(
        "analyze-batch", help="Analyze a batch of file changes"
    )
    _add_common(batch_parser)
    batch_parser.add_argument(
        "--changes-file",
        required=True,
        help="JSON file with changes, or - to read them from stdin",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "analyze-change":
            return asyncio.run(run_change(args))
        return asyncio.run(run_batch(args))
    except KeyboardInterrupt:
        emit_event(
            "error", data={"message": "Operation cancelled", "code": "cancelled"}
        )
        return 1


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
