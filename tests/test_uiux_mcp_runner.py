"""The `workpilot-uiux` MCP server, started the way an agent's MCP config starts it.

JSON-RPC lines on stdin, answers on stdout: the handshake, the tool list, and
the project the server answers for when nothing names it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "uiux_mcp.py"


def _talk(cwd: Path, *args: str, env: dict | None = None) -> list[dict]:
    requests = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "uiux_project_design_system", "arguments": {}},
        },
    ]
    done = subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=cwd,
        input="".join(json.dumps(r) + "\n" for r in requests),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={
            **os.environ,
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            **(env or {}),
        },
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return [json.loads(line) for line in done.stdout.splitlines()]


def _design_system_answer(answers: list[dict]) -> str:
    [call] = [a for a in answers if a["id"] == 3]
    return call["result"]["content"][0]["text"]


def test_the_server_answers_for_the_project_it_is_given(tmp_path: Path) -> None:
    project = tmp_path / "shop"
    project.mkdir()
    answers = _talk(tmp_path, "--project-dir", str(project))
    assert answers[0]["result"]["serverInfo"]["name"] == "workpilot-uiux"
    names = {t["name"] for t in answers[1]["result"]["tools"]}
    assert {"uiux_search", "uiux_project_design_system"} <= names
    assert "no design-system/<project>/MASTER.md yet" in _design_system_answer(answers)


def test_without_a_project_dir_the_working_directory_is_the_project(tmp_path):
    master = tmp_path / "design-system" / "shop" / "MASTER.md"
    master.parent.mkdir(parents=True)
    master.write_text("# Shop design system\n\nPrimary: teal.\n", encoding="utf-8")
    env = {"WORKPILOT_UIUX_ROOT": ""}
    assert "Primary: teal." in _design_system_answer(_talk(tmp_path, env=env))
