"""The Team Bot runner reads its input from stdin (F177).

The webhook URL is a credential: on a command line (`--payload <json>`) every
local process could list it. The app now passes `--payload -` and writes the
JSON to the runner's stdin.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "team_bot_runner.py"


def _run(stdin: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--action", "test", "--payload", "-"],
        input=stdin,
        # As the app starts it: from the backend, with the backend on the path.
        cwd=BACKEND,
        env={**os.environ, "PYTHONPATH": str(BACKEND)},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_the_payload_is_read_from_stdin():
    # No URL: nothing is posted, and the runner answers from the stdin config.
    payload = {"config": {"kind": "slack", "webhook_url": ""}}
    assert _run(json.dumps(payload)) == {"ok": False}


def test_a_broken_stdin_payload_is_an_error_not_a_crash():
    assert "error" in _run("not json")
