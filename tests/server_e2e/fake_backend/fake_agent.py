"""A stand-in for the agent a server run starts: no model, no network but the
stream, a few seconds of work.

The server starts ``run.py`` (or ``runners/spec_runner.py`` for the ``spec``
phase) from its backend directory, confined to the run's project
(``server.services.run_isolation``). The end-to-end test points that directory
here, so a run goes through everything the server does around an agent (the
queue, the confinement, the run's environment and stream token, the status
and the board events) with this script in place of the model.

What it does, in order:

1. reads the probes in its task (lines ``probe-read <path>`` and
   ``probe-list <path>``) and tries each one, as an agent steered by a
   hostile card would; the verdicts go to ``fake_agent_report.json`` in its
   spec directory, which the test reads;
2. publishes ``progress_update`` events on its own channel, ``run:<id>``,
   with the stream token the server minted for it, until the test drops
   ``e2e-release`` in the spec directory (it gives up, and fails, after
   ``RELEASE_TIMEOUT_S``);
3. writes ``spec.md`` (the ``spec`` phase) and exits 0.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path

RELEASE_FILE = "e2e-release"
REPORT_FILE = "fake_agent_report.json"
RELEASE_TIMEOUT_S = 120.0


def _parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-dir")
    parser.add_argument("--task-file")
    args, _ = parser.parse_known_args(argv)
    return args


def _probe(task: str) -> dict[str, str]:
    verdicts: dict[str, str] = {}
    for line in task.splitlines():
        verb, _, target = line.strip().partition(" ")
        if verb not in ("probe-read", "probe-list") or not target:
            continue
        try:
            if verb == "probe-read":
                Path(target).read_bytes()
            else:
                os.listdir(target)
            verdicts[f"{verb} {target}"] = "allowed"
        except PermissionError:
            verdicts[f"{verb} {target}"] = "denied"
        except OSError as exc:
            verdicts[f"{verb} {target}"] = f"error {type(exc).__name__}"
    return verdicts


def _run_id(token: str) -> str:
    """The run the stream token names (its ``run`` claim). Read, not verified:
    the streaming server verifies it."""
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["run"])


def _publish_until_released(spec_dir: Path) -> bool:
    from websockets.sync.client import connect

    token = os.environ["WORKPILOT_WS_TOKEN"]
    channel = f"run:{_run_id(token)}"
    base = os.environ.get("WORKPILOT_WS_URL", "ws://127.0.0.1:8765")
    deadline = time.monotonic() + RELEASE_TIMEOUT_S
    step = 0
    with connect(f"{base}/stream/{channel}?token={token}") as ws:
        while time.monotonic() < deadline:
            step += 1
            ws.send(
                json.dumps(
                    {
                        "type": "agent_event",
                        "event": {
                            "event_type": "progress_update",
                            "timestamp": time.time(),
                            "session_id": channel,
                            "data": {"message": "fake agent working", "step": step},
                        },
                    }
                )
            )
            if (spec_dir / RELEASE_FILE).exists():
                return True
            time.sleep(0.3)
    return False


def main(phase: str, argv: list[str]) -> int:
    args = _parse(argv)
    project = Path(args.project_dir)
    if args.spec_dir:
        spec_dir = Path(args.spec_dir)
    else:
        spec_dir = project / ".workpilot" / "specs" / str(args.spec)
    task = ""
    if args.task_file:
        task = Path(args.task_file).read_text(encoding="utf-8")

    report = {
        "phase": phase,
        "home": os.environ.get("HOME", ""),
        "has_database_url": "WORKPILOT_DATABASE_URL" in os.environ,
        "has_jwt_secret": "WORKPILOT_JWT_SECRET" in os.environ,
        "probes": _probe(task),
    }
    (spec_dir / REPORT_FILE).write_text(json.dumps(report, indent=1), encoding="utf-8")

    if not _publish_until_released(spec_dir):
        return 1
    if phase == "spec":
        (spec_dir / "spec.md").write_text(
            "# Spec written by the fake agent\n\n" + task, encoding="utf-8"
        )
    return 0
