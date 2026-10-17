"""Regenerate the pi JSON-mode fixtures in this directory against a real `pi` binary.

The events are pi's own; only the model is fake. A tiny OpenAI-compatible
server scripts one answer per model id, so no provider, no credential and no
network are involved — the ``apiKey`` pi sends is the dummy ``sk-test-0000``.

Run from the repository root, with ``pi`` on PATH (``npm install -g
--ignore-scripts @earendil-works/pi-coding-agent``)::

    python tests/fixtures/pi/capture.py

What each fixture proves (see docs/architecture/pi.md, lot 0):

- ``tool-call.jsonl``: a turn that runs the ``ls`` tool, with ``usage`` on
  every ``message_update`` / ``message_end`` and ``agent_settled`` last.
- ``resume-by-id.jsonl``: ``--session <uuid>`` continues the session of the
  first run from the directory ``PI_CODING_AGENT_SESSION_DIR`` names.
- ``auth-error.jsonl``: a 401 becomes ``stopReason: "error"`` with the
  provider's message in ``errorMessage``; the process still exits 0.
- ``unknown-model.jsonl``: a model id absent from ``models.json`` is a warning
  on stderr, not a refusal — the provider decides.
- ``readonly-write-refused.jsonl``: with ``--tools read,grep,find,ls`` a
  ``write`` call is answered ``Tool write not found`` and nothing is written.
- ``length.jsonl``: an answer cut by the output limit is ``stopReason: "length"``.

Everything pi runs here is confined to a temporary directory: its agent dir
(``PI_CODING_AGENT_DIR``), its session dir and the project it works in.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 18765
DUMMY_KEY = "sk-test-0000"
SESSION_ID = "11111111-1111-4111-8111-111111111111"
USAGE = {"prompt_tokens": 120, "completion_tokens": 9, "total_tokens": 129}


def _chunk(delta: dict, finish: str | None = None, usage: dict | None = None) -> bytes:
    body: dict = {
        "id": "chatcmpl-fake",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "fake",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n".encode()


def _tool_call(call_id: str, name: str, arguments: dict) -> bytes:
    return _chunk(
        {
            "tool_calls": [
                {
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
            ]
        }
    )


def _script(model: str, messages: list[dict]) -> list[bytes]:
    had_tool_result = any(m.get("role") == "tool" for m in messages)
    if model == "fake-tool":
        if not had_tool_result:
            return [
                _chunk({"role": "assistant", "content": ""}),
                _tool_call("call_ls_1", "ls", {"path": "."}),
                _chunk({}, "tool_calls", USAGE),
            ]
        return [
            _chunk({"role": "assistant", "content": "Listed "}),
            _chunk({"content": "the directory."}),
            _chunk({}, "stop", USAGE),
        ]
    if model == "fake-write":
        if not had_tool_result:
            return [
                _chunk({"role": "assistant", "content": ""}),
                _tool_call("call_write_1", "write", {"path": "should-not-exist.txt", "content": "x"}),
                _chunk({}, "tool_calls", USAGE),
            ]
        return [
            _chunk({"role": "assistant", "content": "I tried to write a file."}),
            _chunk({}, "stop", USAGE),
        ]
    if model == "fake-length":
        return [
            _chunk({"role": "assistant", "content": "This answer is cut"}),
            _chunk({}, "length", USAGE),
        ]
    return [
        _chunk({"role": "assistant", "content": "Hello from the fake model."}),
        _chunk({}, "stop", USAGE),
    ]


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # noqa: D102 - quiet
        pass

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        model = payload.get("model", "")
        if model == "fake-auth":
            body = json.dumps(
                {
                    "error": {
                        "message": f"Incorrect API key provided: {DUMMY_KEY}.",
                        "type": "invalid_request_error",
                        "code": "invalid_api_key",
                    }
                }
            ).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for part in _script(model, payload.get("messages", [])):
            self.wfile.write(part)
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


RUNS: tuple[tuple[str, str, list[str], str], ...] = (
    # fixture, model, extra args, prompt
    ("tool-call", "fake-tool", ["--session-id", SESSION_ID, "--tools", "read,bash,edit,write,grep,find,ls"], "Use the ls tool on the current directory, then stop."),
    ("resume-by-id", "fake-tool", ["--session", SESSION_ID, "--tools", "read,bash,edit,write,grep,find,ls"], "Second turn."),
    ("auth-error", "fake-auth", [], "Hello"),
    ("unknown-model", "does-not-exist", [], "Hello"),
    ("readonly-write-refused", "fake-write", ["--tools", "read,grep,find,ls"], "Write a file"),
    ("length", "fake-length", [], "Hello"),
)


def _neutralise(line: str, project: str) -> str:
    event = json.loads(line.replace(project, "/work/project"))
    if event.get("type") == "agent_end":
        event["messages"] = ["<elided: the whole conversation, already streamed above>"]
    message = event.get("message") if isinstance(event.get("message"), dict) else None
    if event.get("type") in ("message_start", "message_end") and message and message.get("role") == "system":
        # pi's own system prompt, several KB of prose: keep the shape, not the text.
        message["sections"] = {key: "<elided>" for key in message.get("sections", {})}
    return json.dumps(event, ensure_ascii=False)


def main() -> int:
    pi = shutil.which("pi")
    if not pi:
        print("pi is not on PATH", file=sys.stderr)
        return 2
    server = ThreadingHTTPServer(("127.0.0.1", PORT), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="workpilot-pi-fixtures-") as tmp:
        root = Path(tmp)
        agent_dir, session_dir, project = root / "agent", root / "sessions", root / "project"
        for d in (agent_dir, session_dir, project):
            d.mkdir()
        (agent_dir / "models.json").write_text(
            json.dumps(
                {
                    "providers": {
                        "fake": {
                            "baseUrl": f"http://127.0.0.1:{PORT}/v1",
                            "api": "openai-completions",
                            "apiKey": DUMMY_KEY,
                            "models": [{"id": m} for m in ("fake-tool", "fake-write", "fake-auth", "fake-length")],
                        }
                    }
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        (project / "AGENTS.md").write_text("# AGENTS.md (fixture project)\n", encoding="utf-8")
        (project / "README.md").write_text("hello\n", encoding="utf-8")
        env = {
            **{k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE")},
            "PI_CODING_AGENT_DIR": str(agent_dir),
            "PI_CODING_AGENT_SESSION_DIR": str(session_dir),
            "PI_SKIP_VERSION_CHECK": "1",
        }
        version = subprocess.run([pi, "--version"], capture_output=True, text=True, env=env, check=False).stdout.strip()
        for name, model, extra, prompt in RUNS:
            result = subprocess.run(
                [pi, "--mode", "json", "--model", f"fake/{model}", *extra],
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                cwd=project,
                env=env,
                check=False,
            )
            lines = [_neutralise(line, str(project)) for line in result.stdout.splitlines() if line.strip()]
            (HERE / f"{name}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
            print(f"{name}.jsonl: {len(lines)} events, exit {result.returncode}, stderr: {result.stderr.strip()[:120] or '-'}")
        assert not (project / "should-not-exist.txt").exists(), "the read-only allowlist let a write through"
    (HERE / "VERSION").write_text(f"{version}\n", encoding="utf-8")
    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
