"""The session templates, composed and refined offline against a local Ollama (#344).

The issue asks for the templates to be checked in CI against a local Ollama, so
that a crew can be composed with no network. The CI hosts no model, so the
Ollama here is a real HTTP server on 127.0.0.1 answering the two routes the
client uses (`/api/show`, `/api/chat`). Every connection to anything but the
loopback is refused at the socket: a call that left the machine fails the test.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from core.oneshot import oneshot_completion
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control.templates import TEMPLATES
from offline_policy import local_model_catalog

from .conftest import closed_port

URL = "/api/mission-control/composition"
MODEL = "qwen3-coder"

# What each template is, said the way a person would.
DESCRIPTIONS = {
    "bug_fix": "Fix the crash of the login screen when the API times out",
    "new_feature": "Add a settings page with a dark mode toggle and an export button",
    "refactor_module": "Refactor the billing module into smaller services",
    "incident_response": "Production is down: payments fail since the last deploy",
    "generic": "Look at the project and improve whatever needs it",
}


class _Ollama(BaseHTTPRequestHandler):
    """Ollama's `/api/show` and `/api/chat`, with what the test set."""

    capabilities: list[str] | None = ["completion", "tools"]
    answer = "{}"
    seen: list[tuple[str, dict]] = []

    def _send(self, body: str, content_type: str = "application/json") -> None:
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802 - the stdlib's spelling
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).seen.append((self.path, body))
        if self.path == "/api/show":
            caps = type(self).capabilities
            self._send(json.dumps({} if caps is None else {"capabilities": caps}))
            return
        message = {"role": "assistant", "content": type(self).answer}
        lines = [
            {"message": message, "done": False},
            {
                "message": {"role": "assistant", "content": ""},
                "done": True,
                "prompt_eval_count": 120,
                "eval_count": 30,
            },
        ]
        self._send(
            "\n".join(json.dumps(line) for line in lines) + "\n",
            "application/x-ndjson",
        )

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture(scope="module")
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Ollama)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture
def ollama(server, monkeypatch):
    """The local Ollama, and nothing else the process can reach."""
    monkeypatch.setenv("OLLAMA_BASE_URL", server)
    monkeypatch.setenv("OLLAMA_MODEL", MODEL)
    monkeypatch.setattr(_Ollama, "capabilities", ["completion", "tools"])
    monkeypatch.setattr(_Ollama, "seen", [])
    connect = socket.socket.connect

    def loopback_only(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in (
            "127.0.0.1",
            "::1",
        ):
            raise ConnectionRefusedError(f"offline test: {address[0]} refused")
        return connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", loopback_only)
    return _Ollama


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(mc_api.router)
    return TestClient(app)


def _compose(client, **body) -> dict:
    return client.post(URL, json={"providers": ["ollama"], **body}).json()


def _ask(request: dict) -> str:
    """The light model's call, made the way the main process makes it."""
    return asyncio.run(
        oneshot_completion(
            request["prompt"],
            system_prompt=request["system_prompt"],
            provider=request["provider"],
            model=request["model"] or None,
            require_provider=True,
        )
    )


@pytest.mark.parametrize("key", sorted(TEMPLATES))
def test_every_template_composes_and_refines_on_a_local_ollama(key, client, ollama):
    first = _compose(client, prompt=DESCRIPTIONS[key], template=key, refine=True)
    assert first["success"] is True, first
    composition = first["composition"]
    assert composition["status"] == "ok"
    assert composition["template"] == key
    agents = composition["proposed"]["agents"]
    assert agents and {a["provider"] for a in agents} == {"ollama"}
    assert {a["model"] for a in agents} == {MODEL}
    assert composition["proposed"]["cost_usd"] == 0
    request = composition["refinement"]
    assert (request["provider"], request["model"]) == ("ollama", MODEL)

    # The light model names the work; a generic description is a refactor here.
    kind = "refactor_module" if key == "generic" else key
    ollama.answer = json.dumps(
        {"kind": kind, "complexity": "small", "domains": ["backend"]}
    )
    answer = _ask(request)
    assert json.loads(answer)["kind"] == kind

    second = _compose(client, prompt=DESCRIPTIONS[key], model_hints=answer)
    assert second["composition"]["hinted"] is True
    assert second["composition"]["template"] == kind
    assert second["composition"]["complexity"] == "small"
    # The model was asked once whether it calls tools, then the answer was kept.
    paths = [path for path, _ in ollama.seen]
    assert paths == ["/api/show", "/api/show", "/api/chat"]
    assert ollama.seen[0][1] == {"model": MODEL}


def test_a_model_the_server_says_has_no_tools_reads_no_code(client, ollama):
    ollama.capabilities = ["completion"]
    body = _compose(client, prompt=DESCRIPTIONS["bug_fix"], template="bug_fix")
    # Every role of a bug fix reads and changes code.
    assert body == {"success": False, "error": "no_capable_model"}


def test_an_older_server_leaves_tool_use_unknown(client, ollama):
    ollama.capabilities = None
    body = _compose(client, prompt=DESCRIPTIONS["bug_fix"], template="bug_fix")
    assert body["composition"]["status"] == "ok"


def test_a_server_that_is_down_leaves_tool_use_unknown(monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", f"http://127.0.0.1:{closed_port()}")
    assert local_model_catalog.ollama_tool_use(MODEL) is None


def test_only_a_loopback_server_is_asked(monkeypatch, ollama):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.example.com:11434")
    assert local_model_catalog.ollama_tool_use(MODEL) is None
    assert local_model_catalog.ollama_tool_use("") is None
    assert ollama.seen == []


def test_an_answer_is_kept_and_a_silence_asked_again(monkeypatch, ollama):
    clock = iter([0.0, 10.0, 0.0, 30.0, 61.0, 61.0, 700.0])
    monkeypatch.setattr(local_model_catalog.time, "monotonic", lambda: next(clock))
    assert local_model_catalog.ollama_tool_use(MODEL) is True
    assert local_model_catalog.ollama_tool_use(MODEL) is True
    assert len(ollama.seen) == 1

    ollama.capabilities = None
    monkeypatch.setattr(local_model_catalog, "_TOOLS", {})
    assert local_model_catalog.ollama_tool_use(MODEL) is None
    # A silence is asked again after a minute, an answer after ten.
    assert local_model_catalog.ollama_tool_use(MODEL) is None
    ollama.capabilities = ["tools"]
    assert local_model_catalog.ollama_tool_use(MODEL) is True
    assert len(ollama.seen) == 3
    ollama.capabilities = []
    assert local_model_catalog.ollama_tool_use(MODEL) is True
    assert local_model_catalog.ollama_tool_use(MODEL) is False
