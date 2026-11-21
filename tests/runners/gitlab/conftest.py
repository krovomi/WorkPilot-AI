"""Stand-ins for the GitLab review tests: a GitLab instance and a model.

GitLab is a real HTTP server on 127.0.0.1 answering the REST v4 calls the
runner makes (``--instance`` points at it), recording each request it gets.
The model is a client that streams the answer a provider would, as
``AgentMessage`` objects, and keeps the prompt it was asked.
Everything else (files under ``.workpilot/gitlab``, the review engine, the
orchestrator, the CLI) is the real code.
"""

from __future__ import annotations

import importlib
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

TOKEN = "glpat-test-0000"  # pragma: allowlist secret
PROJECT = "group/app"
API = "/api/v4/projects/group%2Fapp"


@dataclass
class Answer:
    status: int = 200
    body: object = None
    raw: bytes | None = None
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class Request:
    method: str
    path: str
    headers: dict[str, str]
    body: object


class FakeGitLab:
    """An HTTP server that plays queued answers per (method, path)."""

    Answer = Answer
    token = TOKEN
    project = PROJECT
    api = API

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], list[Answer]] = {}
        self.requests: list[Request] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                fake.requests.append(
                    Request(
                        self.command,
                        self.path,
                        {k.lower(): v for k, v in self.headers.items()},
                        json.loads(raw) if raw else None,
                    )
                )
                queue = fake.routes.get((self.command, self.path))
                if not queue:
                    answer = Answer(404, {"message": "404 Not found"})
                else:
                    answer = queue.pop(0) if len(queue) > 1 else queue[0]
                payload = (
                    answer.raw
                    if answer.raw is not None
                    else b""
                    if answer.status == 204
                    else json.dumps(answer.body).encode("utf-8")
                )
                self.send_response(answer.status)
                for name, value in answer.headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PUT = _serve

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(
            target=self.server.serve_forever, args=(0.05,), daemon=True
        )
        self._thread.start()

    def answer(self, method: str, path: str, *answers: Answer) -> None:
        """Queue answers for a route; the last one keeps being served."""
        self.routes[(method, path)] = list(answers)

    def serve_mr(
        self,
        iid: int,
        *,
        title: str = "Add login rate limit",
        description: str | None = "Limits login attempts per IP.",
        sha: str | None = "abc1234def5678",
        changes: list[dict] | None = None,
        commits: list[dict] | None = None,
        **mr: object,
    ) -> None:
        """Serve an MR, its changes and its commits the way GitLab does."""
        base = f"{API}/merge_requests/{iid}"
        self.answer(
            "GET",
            base,
            Answer(
                body={
                    "iid": iid,
                    "title": title,
                    "description": description,
                    "author": {"username": "ann"},
                    "source_branch": "feat/rate-limit",
                    "target_branch": "main",
                    "state": "opened",
                    "sha": sha,
                    **mr,
                }
            ),
        )
        self.answer(
            "GET",
            f"{base}/changes",
            Answer(body={"changes": DEFAULT_CHANGES if changes is None else changes}),
        )
        self.answer(
            "GET",
            f"{base}/commits",
            Answer(
                body=[{"id": sha, "title": "Rate limit"}]
                if commits is None
                else commits
            ),
        )

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


DEFAULT_CHANGES = [
    {
        "old_path": "app/login.py",
        "new_path": "app/login.py",
        "diff": "--- a/app/login.py\n+++ b/app/login.py\n@@ -1,2 +1,3 @@\n-def login():\n+def login(ip):\n+    check_rate(ip)\n     pass\n",
    },
    {
        "old_path": "app/rate.py",
        "new_path": "app/rate.py",
        "diff": "+def check_rate(ip):\n+    return True\n",
    },
]


@pytest.fixture
def gitlab():
    server = FakeGitLab()
    yield server
    server.close()


class Model:
    """A client that streams one scripted answer and keeps the prompt."""

    def __init__(self, messages, fail: BaseException | None = None) -> None:
        self.messages = list(messages)
        self.fail = fail
        self.prompts: list[str] = []
        self.created_with: dict = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        if self.fail:
            raise self.fail
        for message in self.messages:
            yield message


def says(*texts: str):
    """The assistant messages a provider streams for these texts."""
    ac = importlib.import_module("core.agent_client")
    return [
        ac.AgentMessage(
            role=ac.MessageRole.ASSISTANT,
            content=[ac.ContentBlock(type=ac.ContentBlockType.TEXT, text=t)],
        )
        for t in texts
    ]


def review_answer(
    verdict: str = "ready_to_merge",
    findings: list[dict] | None = None,
    summary: str = "Solid change.",
) -> str:
    """A review the way the prompt asks the model to write it."""
    data = {
        "summary": summary,
        "verdict": verdict,
        "verdict_reasoning": "Because.",
        "findings": findings or [],
    }
    return f"Here is my review.\n\n```json\n{json.dumps(data, indent=2)}\n```\n"


def finding(title: str, severity: str = "medium", **extra) -> dict:
    return {
        "severity": severity,
        "category": "quality",
        "title": title,
        "description": f"{title} explained.",
        "file": "app/login.py",
        "line": 2,
        **extra,
    }


@pytest.fixture
def model(monkeypatch):
    """Install a stand-in model behind ``core.client.create_agent_client``."""

    def install(messages=(), fail: BaseException | None = None) -> Model:
        stand_in = Model(messages, fail)

        def create_agent_client(**kwargs):
            stand_in.created_with = kwargs
            return stand_in

        monkeypatch.setattr(
            importlib.import_module("core.client"),
            "create_agent_client",
            create_agent_client,
        )
        return stand_in

    return install


@pytest.fixture
def llm():
    """Helpers to write what the model streams."""
    return SimpleNamespace(says=says, review=review_answer, finding=finding)
