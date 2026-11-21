#!/usr/bin/env python3
"""
Browser Agent recorder: record a session, export it as a test.

Subcommands:
  record --url URL           open URL in a browser window and record what the
                             person does there, until a ``stop`` line on stdin
                             or the window is closed; a dialog the page opens is
                             asked of the app (``RECORDER_DIALOG``) and answered
                             by a ``dialog <JSON>`` line on stdin
  export --format F [--name N] [--root DIR]
                             read a recording (JSON) on stdin and print it as a
                             test file: Playwright (TypeScript, Python) or Cypress
  run --project P --root DIR --file F --format F --spec S
                             prepare the review card's worktree DIR, run the
                             test F there with its format's runner, count its
                             first run in the project
  reshoot --project P        replay a recording (JSON, stdin) without a window
                             and say, per step, whether its selectors still work

Output lines (stdout), for the desktop app:
  RECORDER_STEP:<step JSON>       a step added or updated (``record``)
  RECORDER_DONE:<summary JSON>    the recording ended (``record``)
  RECORDER_DIALOG:<dialog JSON>   the page opened a dialog: type, message (``record``)
  RECORDER_EXPORT:<test JSON>     the generated test (``export``)
  RECORDER_RUN:<result JSON>      passed, exit code, output, first-run counts (``run``)
  RECORDER_RESHOOT:<steps JSON>   per step: ok, changed (new selectors), missing… (``reshoot``)
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
DIALOG = "RECORDER_DIALOG:"
#: A dialog nobody answers is dismissed after this long.
DIALOG_TIMEOUT_S = 300.0
#: An answer line: ``dialog {"id": 1, "accept": true, "text": "..."}``.
MAX_ANSWER = 4000
EXPORT = "RECORDER_EXPORT:"
RUN = "RECORDER_RUN:"
RESHOOT = "RECORDER_RESHOOT:"
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


def read_answer(raw: str) -> tuple[int, bool, str] | None:
    """A dialog answer the app sent (``{"id", "accept", "text"}``), or None."""
    from browser_agent.recording import MAX_VALUE, clean_value

    if len(raw) > MAX_ANSWER:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("accept"), bool):
        return None
    dialog_id = data.get("id")
    if type(dialog_id) is not int:
        return None
    text = data.get("text", "")
    text = clean_value(text if isinstance(text, str) else "", MAX_VALUE)
    return dialog_id, data["accept"], text


class Control:
    """What the app says on stdin: ``stop``, and the answers to dialogs."""

    def __init__(self, lines=None) -> None:
        self._lines = lines or (lambda: asyncio.to_thread(sys.stdin.readline))
        self.stopped = asyncio.Event()
        self.answers: asyncio.Queue[tuple[int, bool, str]] = asyncio.Queue()
        self._next = 0

    async def listen(self) -> None:
        """Until a ``stop`` line, or stdin closes (the app went away)."""
        while True:
            line = await self._lines()
            command = line.strip() if line else "stop"
            if command == "stop":
                self.stopped.set()
                return
            if command.startswith("dialog "):
                answer = read_answer(command[len("dialog ") :])
                if answer is not None:
                    await self.answers.put(answer)

    async def ask_dialog(self, dialog: dict[str, str]) -> tuple[bool, str] | None:
        """Shows the dialog in the app and waits for the person's answer to it.

        Each dialog has an id; an answer to another one (a dialog that timed
        out, a stray line) is dropped.
        """
        self._next += 1
        wanted = self._next
        _emit(DIALOG, {"id": wanted, **dialog})
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DIALOG_TIMEOUT_S
        while True:
            try:
                dialog_id, accept, text = await asyncio.wait_for(
                    self.answers.get(), max(0.0, deadline - loop.time())
                )
            except TimeoutError:
                return None
            if dialog_id == wanted:
                return accept, text


def _controller(project: Path):
    from browser_agent.browser_controller import BrowserController

    return BrowserController(project_dir=project, headless=False)


async def run_record(url: str, project: Path) -> dict:
    """Record from ``url`` and return the summary printed as ``RECORDER_DONE``."""
    from browser_agent.recorder import record_session

    controller = _controller(project)
    control = Control()
    listening = asyncio.ensure_future(control.listen())
    try:
        await controller.launch()
        recording, reason = await record_session(
            controller.page,
            url,
            control.stopped.wait(),
            lambda step: _emit(STEP, step.to_dict()),
            ask_dialog=control.ask_dialog,
        )
    finally:
        listening.cancel()
        await controller.close()
    return {
        "reason": reason,
        "steps": len(recording.steps),
        "truncated": recording.truncated,
    }


def run_export(raw: str, fmt: str, name: str | None, root: Path | None) -> dict:
    """The generated test for the recording in ``raw`` (JSON)."""
    from browser_agent.codegen import export_recording

    return export_recording(_recording(raw, "export"), fmt, name, root).to_dict()


def _recording(raw: str, action: str):
    from browser_agent.recording import Recording

    if len(raw) > MAX_INPUT:
        raise ValueError(f"The recording is too large to {action}.")
    recording = Recording.from_dict(json.loads(raw))
    if not recording.steps:
        raise ValueError(f"The recording has no step to {action}.")
    return recording


def run_test(project: Path, root: Path, rel: str, fmt: str, spec: str) -> dict:
    """Prepare the worktree ``root`` and run the recorded test ``rel`` there."""
    from browser_agent.recorder_run import run_recorded_test
    from core.workspace.recipe_run import prepare_worktree

    if not root.is_dir():
        raise ValueError(f"Worktree not found: {root}")
    return run_recorded_test(
        project,
        root,
        rel,
        fmt,
        lambda: prepare_worktree(project, root, spec).status,
    ).to_dict()


async def run_reshoot(raw: str, project: Path) -> dict:
    """Replay the recording in ``raw`` without a window: what each step found."""
    from browser_agent.browser_controller import BrowserController
    from browser_agent.recorder_replay import reshoot

    recording = _recording(raw, "replay")
    start = next((s for s in recording.steps if s.kind == "navigate"), None)
    if start is None:
        raise ValueError("The recording opens no page.")
    check_url(start.url, project)
    controller = BrowserController(project_dir=project, headless=True)
    try:
        await controller.launch()
        shots = await reshoot(controller.page, recording)
    finally:
        await controller.close()
    return {"steps": [shot.to_dict() for shot in shots]}


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
    run = sub.add_parser("run", help="Run a recorded test in its worktree")
    run.add_argument("--project", required=True)
    run.add_argument("--root", required=True, help="The review card's worktree")
    run.add_argument("--file", required=True, help="The test, relative to --root")
    run.add_argument("--format", required=True, choices=FORMATS)
    run.add_argument("--spec", required=True, help="The review card's spec")
    shoot = sub.add_parser("reshoot", help="Replay a recording (stdin) headless")
    shoot.add_argument("--project", required=True)
    args = parser.parse_args(argv)

    try:
        project = Path(getattr(args, "project", None) or ".").resolve()
        if args.command != "export" and not project.is_dir():
            raise ValueError(f"Project directory not found: {project}")
        if args.command == "record":
            url = check_url(args.url, project)
            _emit(DONE, asyncio.run(run_record(url, project)))
        elif args.command == "run":
            root = Path(args.root).resolve()
            _emit(RUN, run_test(project, root, args.file, args.format, args.spec))
        elif args.command == "reshoot":
            raw = sys.stdin.read(MAX_INPUT + 1)
            _emit(RESHOOT, asyncio.run(run_reshoot(raw, project)))
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
