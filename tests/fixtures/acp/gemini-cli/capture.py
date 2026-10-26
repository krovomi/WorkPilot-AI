"""Regenerate the Gemini CLI ACP fixtures in this directory against a real `gemini`.

The messages are Gemini CLI's own; only the model is fake. A tiny server
speaking the Gemini API (`GOOGLE_GEMINI_BASE_URL`) answers each
`streamGenerateContent` with one scripted function call, then with "Done." once
the call's result comes back. The key Gemini sends is the dummy
``sk-test-0000``: no account, no credential, no network.

Run from the repository root, with ``gemini`` on PATH (``npm install -g
--ignore-scripts @google/gemini-cli``)::

    python tests/fixtures/acp/gemini-cli/capture.py

Each fixture is one JSON object per line, ``{"dir": "out" | "in", "msg": …}``:
``out`` is what the client sent, ``in`` what Gemini answered or asked. Paths
under the temporary project read ``$PROJECT``, the session id ``$SESSION``.
The client side answers as `AcpAgentClient` does: reads stay with Gemini
(``fs.readTextFile: false``, see `docs/architecture/acp.md`), writes come back
to the client.

- ``auth-required.jsonl``: no credential at all; ``initialize`` answers (the
  agent's capabilities need no login) and ``session/new`` is refused.
- ``write-allowed.jsonl``: ``write_file`` is a ``tool_call`` of kind ``edit``
  (``pending``), then ``session/request_permission`` with Gemini's three
  options; ``proceed_once`` is chosen, the write arrives as
  ``fs/write_text_file`` and the turn ends ``end_turn`` with ``usage``.
- ``write-rejected.jsonl``: the same, answered ``cancel`` (``reject_once``).
- ``shell-unasked.jsonl``: ``run_shell_command echo hi`` is kind
  ``execute`` and runs **without** a permission request: Gemini's default
  policy lets a command it reads as harmless through. The client cannot count
  on being asked.
- ``shell-asked.jsonl``: ``touch made.txt`` is asked, answered ``cancel``, and
  nothing is created.
- ``plan-mode-write.jsonl``: after ``session/set_mode`` to ``plan``, the same
  ``write_file`` is refused by Gemini itself without asking.
- ``plan-mode-shell.jsonl``: in ``plan`` mode, ``echo hi`` as well.
- ``resume.jsonl``: a second process loads the first one's session with
  ``session/load`` and continues it.
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
PORT = 18791
DUMMY_KEY = "sk-test-0000"
MODEL = "gemini-2.5-flash"
CLIENT_CAPABILITIES = {
    "fs": {"readTextFile": False, "writeTextFile": True},
    "terminal": False,
}

_CALL: dict = {}


class _FakeGemini(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # noqa: D401 - silence the server
        pass

    def do_POST(self) -> None:  # noqa: N802 - http.server's name
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        if "countTokens" in self.path:
            self._json({"totalTokens": 42})
            return
        request = json.loads(body or b"{}")
        contents = request.get("contents") or [{}]
        answered = any("functionResponse" in p for p in contents[-1].get("parts", []))
        parts = (
            [{"text": "Done."}] if answered or not _CALL else [{"functionCall": _CALL}]
        )
        chunk = {
            "candidates": [
                {
                    "content": {"role": "model", "parts": parts},
                    "finishReason": "STOP",
                    "index": 0,
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 120,
                "candidatesTokenCount": 9,
                "totalTokenCount": 129,
            },
            "modelVersion": MODEL,
        }
        if "alt=sse" in self.path:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\r\n\r\n")
        else:
            self._json(chunk)

    def _json(self, value: dict) -> None:
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)


class _Session:
    """One `gemini --acp` process, driven line by line and recorded."""

    def __init__(self, project: Path, env: dict[str, str], answer: str) -> None:
        self.project = project
        self.answer = answer
        self.lines: list[dict] = []
        self.responses: dict[int, dict] = {}
        self._ids = 0
        self.process = subprocess.Popen(
            [shutil.which("gemini") or "gemini", "--acp", "--model", MODEL],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project,
            env=env,
            text=True,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def _record(self, direction: str, message: dict) -> None:
        self.lines.append({"dir": direction, "msg": message})

    def _write(self, message: dict) -> None:
        self._record("out", message)
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def _read(self) -> None:
        for raw in self.process.stdout:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            self._record("in", message)
            if "method" in message and "id" in message:
                self._answer(message)
            elif "id" in message:
                self.responses[message["id"]] = message

    def _answer(self, request: dict) -> None:
        method = request["method"]
        if method == "session/request_permission":
            options = request["params"]["options"]
            chosen = next(o for o in options if o["kind"] == self.answer)
            result: dict = {
                "outcome": {"outcome": "selected", "optionId": chosen["optionId"]}
            }
            self._write({"jsonrpc": "2.0", "id": request["id"], "result": result})
        elif method == "fs/write_text_file":
            target = Path(request["params"]["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(request["params"]["content"], encoding="utf-8")
            self._write({"jsonrpc": "2.0", "id": request["id"], "result": {}})
        else:
            self._write(
                {
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                }
            )

    def request(self, method: str, params: dict, timeout: float = 60) -> dict:
        request_id = self._ids
        self._ids += 1
        self._write(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        deadline = time.monotonic() + timeout
        while request_id not in self.responses:
            if time.monotonic() > deadline:
                raise TimeoutError(method)
            time.sleep(0.05)
        time.sleep(0.3)  # let trailing notifications land
        return self.responses[request_id]

    def close(self) -> None:
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def _save(name: str, lines: list[dict], project: Path, session_ids: list[str]) -> None:
    text = "\n".join(
        json.dumps(line, ensure_ascii=False) for line in lines if not _noise(line)
    )
    text = text.replace(str(project.resolve()), "$PROJECT").replace(
        str(project), "$PROJECT"
    )
    for session_id in session_ids:
        text = text.replace(session_id, "$SESSION")
    (HERE / name).write_text(text + "\n", encoding="utf-8")
    print(f"wrote {name} ({len(text.splitlines())} lines)")


def _noise(line: dict) -> bool:
    """The slash-command list is long and says nothing the client reads."""
    update = (line["msg"].get("params") or {}).get("update") or {}
    return update.get("sessionUpdate") == "available_commands_update"


def _scenario(
    name: str,
    root: Path,
    env: dict[str, str],
    *,
    call: dict,
    answer: str = "allow_once",
    mode: str | None = None,
) -> str:
    _CALL.clear()
    _CALL.update(call)
    project = root / name.removesuffix(".jsonl")
    project.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    session = _Session(project, env, answer)
    session.request(
        "initialize", {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES}
    )
    session.request("authenticate", {"methodId": "gemini-api-key"})
    created = session.request("session/new", {"cwd": str(project), "mcpServers": []})
    session_id = created["result"]["sessionId"]
    if mode:
        session.request("session/set_mode", {"sessionId": session_id, "modeId": mode})
    session.request(
        "session/prompt",
        {"sessionId": session_id, "prompt": [{"type": "text", "text": "Do it."}]},
    )
    session.close()
    _save(name, session.lines, project, [session_id])
    return session_id


def main() -> int:
    if not shutil.which("gemini"):
        print("gemini is not on PATH", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", PORT), _FakeGemini)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        base_env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("GEMINI_", "GOOGLE_"))
        }
        base_env["HOME"] = str(home)
        base_env["USERPROFILE"] = str(home)

        # No credential: initialize answers, session/new does not.
        bare = root / "auth-required"
        bare.mkdir()
        session = _Session(bare, base_env, "reject_once")
        session.request(
            "initialize",
            {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES},
        )
        session.request("session/new", {"cwd": str(bare), "mcpServers": []})
        session.close()
        _save("auth-required.jsonl", session.lines, bare, [])

        env = {
            **base_env,
            "GEMINI_API_KEY": DUMMY_KEY,
            "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{PORT}",
        }
        write = {
            "name": "write_file",
            "args": {"file_path": "notes/ok.txt", "content": "hello\n"},
        }
        first = _scenario("write-allowed.jsonl", root, env, call=write)
        _scenario("write-rejected.jsonl", root, env, call=write, answer="reject_once")
        _scenario(
            "shell-unasked.jsonl",
            root,
            env,
            call={"name": "run_shell_command", "args": {"command": "echo hi"}},
            answer="reject_once",
        )
        _scenario(
            "shell-asked.jsonl",
            root,
            env,
            call={"name": "run_shell_command", "args": {"command": "touch made.txt"}},
            answer="reject_once",
        )
        _scenario("plan-mode-write.jsonl", root, env, call=write, mode="plan")
        _scenario(
            "plan-mode-shell.jsonl",
            root,
            env,
            call={"name": "run_shell_command", "args": {"command": "echo hi"}},
            mode="plan",
        )

        # A second process continues the first one's session.
        _CALL.clear()
        project = root / "write-allowed"
        session = _Session(project, env, "allow_once")
        session.request(
            "initialize",
            {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES},
        )
        session.request("authenticate", {"methodId": "gemini-api-key"})
        session.request(
            "session/load", {"sessionId": first, "cwd": str(project), "mcpServers": []}
        )
        session.request(
            "session/prompt",
            {"sessionId": first, "prompt": [{"type": "text", "text": "And now?"}]},
        )
        session.close()
        _save("resume.jsonl", session.lines, project, [first])
    server.shutdown()
    version = subprocess.run(
        [shutil.which("gemini"), "--version"], capture_output=True, text=True
    ).stdout.strip()
    (HERE / "VERSION").write_text(version + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
