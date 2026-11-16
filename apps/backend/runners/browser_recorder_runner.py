#!/usr/bin/env python3
"""
Browser Agent recorder: record a session, export it as a test.

Subcommands:
  record --url URL           open URL in a browser window and record what the
                             person does there, until a ``stop`` line on stdin
                             or the window is closed
  export --format F [--name N] [--root DIR]
                             read a recording (JSON) on stdin and print it as a
                             test file: Playwright (TypeScript, Python) or Cypress

Output lines (stdout), for the desktop app:
  RECORDER_STEP:<step JSON>       a step added or updated (``record``)
  RECORDER_DONE:<summary JSON>    the recording ended (``record``)
  RECORDER_EXPORT:<test JSON>     the generated test (``export``)
  RECORDER_ERROR:<message JSON>   what went wrong

No model is called. A strict offline project only records a page of this
computer (``offline_policy``).
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

STEP = "RECORDER_STEP:"
DONE = "RECORDER_DONE:"
EXPORT = "RECORDER_EXPORT:"
ERROR = "RECORDER_ERROR:"
#: A recording sent back by the app: 300 steps fit well under this.
MAX_INPUT = 2_000_000


def _emit(prefix: str, payload: object) -> None:
    print(prefix + json.dumps(payload, ensure_ascii=True), flush=True)


def is_local_url(url: str) -> bool:
    """A page served by this computer (loopback host)."""
    host = (urlsplit(url).hostname or "").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_url(url: str, project: Path) -> str:
    """The URL to record from, or ``ValueError`` with the reason."""
    from browser_agent.recording import MAX_URL, is_web_url
    from offline_policy import STRICT_EXIT_HINT, airgap_status

    if len(url) > MAX_URL or not is_web_url(url):
        raise ValueError("Only an http:// or https:// address can be recorded.")
    if airgap_status(project).get("airgapStrict") and not is_local_url(url):
        raise ValueError(
            "This project is in strict offline mode: only a page of this computer "
            "(localhost) can be recorded. " + STRICT_EXIT_HINT
        )
    return url


async def _stdin_stop() -> None:
    """Resolves on a ``stop`` line, or when stdin closes (the app went away)."""
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line or line.strip() == "stop":
            return


def _controller(project: Path):
    from browser_agent.browser_controller import BrowserController

    return BrowserController(project_dir=project, headless=False)


async def run_record(url: str, project: Path) -> dict:
    """Record from ``url`` and return the summary printed as ``RECORDER_DONE``."""
    from browser_agent.recorder import record_session

    controller = _controller(project)
    try:
        await controller.launch()
        recording, reason = await record_session(
            controller.page,
            url,
            _stdin_stop(),
            lambda step: _emit(STEP, step.to_dict()),
        )
    finally:
        await controller.close()
    return {
        "reason": reason,
        "steps": len(recording.steps),
        "truncated": recording.truncated,
    }


def run_export(raw: str, fmt: str, name: str | None, root: Path | None) -> dict:
    """The generated test for the recording in ``raw`` (JSON)."""
    from browser_agent.codegen import export_recording
    from browser_agent.recording import Recording

    if len(raw) > MAX_INPUT:
        raise ValueError("The recording is too large to export.")
    recording = Recording.from_dict(json.loads(raw))
    if not recording.steps:
        raise ValueError("The recording has no step to export.")
    return export_recording(recording, fmt, name, root).to_dict()


def main(argv: list[str] | None = None) -> int:
    from browser_agent.codegen import FORMATS
    from playwright.async_api import Error as BrowserError

    parser = argparse.ArgumentParser(description="Browser Agent recorder")
    sub = parser.add_subparsers(dest="command", required=True)
    record = sub.add_parser("record", help="Record a session in a browser window")
    record.add_argument("--url", required=True)
    record.add_argument("--project", required=True, help="Project directory")
    export = sub.add_parser("export", help="Write a recording (stdin) as a test")
    export.add_argument("--format", required=True, choices=FORMATS)
    export.add_argument("--name", default=None)
    export.add_argument("--root", default=None, help="Folder the test goes into")
    args = parser.parse_args(argv)

    try:
        if args.command == "record":
            project = Path(args.project).resolve()
            if not project.is_dir():
                raise ValueError(f"Project directory not found: {project}")
            url = check_url(args.url, project)
            _emit(DONE, asyncio.run(run_record(url, project)))
        else:
            root = Path(args.root).resolve() if args.root else None
            raw = sys.stdin.read(MAX_INPUT + 1)
            _emit(EXPORT, run_export(raw, args.format, args.name, root))
    except (ValueError, RuntimeError, OSError, BrowserError) as exc:
        _emit(ERROR, str(exc))
        return 1
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
