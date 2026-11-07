"""A real server-mode stack for the two-organization end-to-end test.

What ``deploy/`` runs, on this machine: ``alembic upgrade head`` on the
database, the streaming server (``websocket_server.py``, port 8765) and the
API (``provider_api:app`` under uvicorn, through ``serve_api.py`` so that runs
start the fake agent). The projects are cloned by the server from a small git
repository this module serves over plain HTTP on the loopback, as a forge
would. People and organizations are made through the HTTP API only, the way
an operator and their team would: the platform administrator by the
``create_admin`` script of the image, everyone else by invitation.

Every secret here (the JWT key, the passwords) is drawn at random for one
session and never written to a file.
"""

from __future__ import annotations

import contextlib
import http.server
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
BACKEND = REPO_ROOT / "apps" / "backend"

#: The streaming server's port: fixed in ``streaming/websocket_server.py``.
WS_PORT = 8765
WS_URL = f"ws://127.0.0.1:{WS_PORT}"

#: What the server processes inherit from the test's environment; the rest is
#: built (docs/rules/security.md, S4). No proxy: everything is on the loopback.
_INHERITED = ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "TMPDIR")


@dataclass
class Person:
    """Someone with an account on the server, and their current access token."""

    key: str
    email: str
    password: str = field(repr=False)
    user_id: str = ""
    token: str = field(default="", repr=False)

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ["git", "-c", "user.name=E2E", "-c", "user.email=e2e@example.com", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def make_origin_repo(root: Path) -> Path:
    """A bare repository with a `main` branch, ready for git's HTTP protocol."""
    work = root / "work"
    work.mkdir(parents=True)
    _git("init", "-q", "-b", "main", str(work))
    (work / "README.md").write_text("# Shared test repository\n", encoding="utf-8")
    (work / "app.py").write_text(
        "def hello() -> str:\n    return 'hi'\n", encoding="utf-8"
    )
    _git("add", ".", cwd=work)
    _git("commit", "-q", "-m", "initial", cwd=work)
    bare = root / "origin.git"
    _git("clone", "-q", "--bare", str(work), str(bare))
    # Git's "dumb" HTTP protocol reads these static files.
    _git("update-server-info", cwd=bare)
    return bare


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


@contextlib.contextmanager
def serve_directory(root: Path) -> Iterator[str]:
    """Serve `root` read-only over HTTP on the loopback; yields the base URL."""
    handler = partial(_QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def server_env(database_url: str, repos_root: Path) -> dict[str, str]:
    env = {k: os.environ[k] for k in _INHERITED if k in os.environ}
    env.update(
        WORKPILOT_SERVER_MODE="true",
        WORKPILOT_DATABASE_URL=database_url,
        WORKPILOT_REPOS_ROOT=str(repos_root),
        WORKPILOT_WS_URL=WS_URL,
        WORKPILOT_JWT_SECRET=secrets.token_hex(32),
        WORKPILOT_RUN_ISOLATION="required",
        GIT_TERMINAL_PROMPT="0",
        PYTHONUNBUFFERED="1",
    )
    return env


def migrate(env: dict[str, str]) -> None:
    """`alembic upgrade head`, as the image's entrypoint does first."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            "server/db/alembic.ini",
            "upgrade",
            "head",
        ],
        cwd=BACKEND,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )


def create_platform_admin(env: dict[str, str], person: Person) -> None:
    """The image's own script, as the operations guide has the operator run it."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "server.scripts.create_admin",
            person.email,
            "--name",
            "Platform Admin",
        ],
        cwd=BACKEND,
        env={**env, "WORKPILOT_ADMIN_PASSWORD": person.password},
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )


class Stack:
    """The running server: its processes, and an HTTP client to its API."""

    def __init__(self, env: dict[str, str], log_dir: Path) -> None:
        self.env = env
        self.log_dir = log_dir
        self.api_port = free_port()
        self.base_url = f"http://127.0.0.1:{self.api_port}"
        self.procs: dict[str, subprocess.Popen[bytes]] = {}
        self.http = httpx.Client(base_url=self.base_url, timeout=60, trust_env=False)

    def _spawn(self, name: str, argv: list[str]) -> None:
        log = (self.log_dir / f"{name}.log").open("wb")
        self.procs[name] = subprocess.Popen(
            argv, cwd=BACKEND, env=self.env, stdout=log, stderr=subprocess.STDOUT
        )
        log.close()

    def logs(self) -> str:
        out = []
        for name in self.procs:
            text = (self.log_dir / f"{name}.log").read_text(
                encoding="utf-8", errors="replace"
            )
            out.append(f"--- {name} ---\n{text[-4000:]}")
        return "\n".join(out)

    def start(self, timeout: float = 120.0) -> None:
        self._spawn("websocket", [sys.executable, "websocket_server.py"])
        self._spawn(
            "api",
            [sys.executable, str(HERE / "serve_api.py"), "--port", str(self.api_port)],
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for name, proc in self.procs.items():
                if proc.poll() is not None:
                    raise RuntimeError(f"{name} exited early\n{self.logs()}")
            try:
                healthy = self.http.get("/health").status_code == 200
            except httpx.HTTPError:
                healthy = False
            if healthy and port_in_use(WS_PORT):
                return
            time.sleep(0.5)
        raise RuntimeError(f"server not ready after {timeout}s\n{self.logs()}")

    def stop(self) -> None:
        self.http.close()
        for proc in self.procs.values():
            if proc.poll() is None:
                proc.terminate()
        for proc in self.procs.values():
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()

    # -- HTTP ---------------------------------------------------------------

    def call(
        self,
        who: Person,
        method: str,
        path: str,
        *,
        org: str | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        headers = dict(who.auth)
        if org:
            headers["X-WorkPilot-Org"] = org
        return self.http.request(method, path, headers=headers, **kwargs)

    def ok(self, who: Person, method: str, path: str, **kwargs: Any) -> Any:
        response = self.call(who, method, path, **kwargs)
        if response.status_code >= 300:
            raise AssertionError(
                f"{who.key} {method} {path} -> {response.status_code} {response.text}"
            )
        return response.json() if response.content else None

    def login(self, who: Person) -> None:
        response = self.http.post(
            "/auth/login", json={"email": who.email, "password": who.password}
        )
        if response.status_code != 200:
            raise AssertionError(
                f"login {who.key}: {response.status_code} {response.text}"
            )
        body = response.json()
        who.token = body["access_token"]
        who.user_id = body["user"]["id"]

    def invite(self, admin: Person, who: Person, org: str, role: str) -> None:
        """Invite `who` into `org` (the organization `admin` acts in), then
        accept as they would: the account is theirs, and a member of `org`
        with the organization role `role` maps onto."""
        created = self.ok(
            admin,
            "POST",
            "/auth/invitations",
            org=org,
            json={"email": who.email, "role": role},
        )
        token = parse_qs(urlparse(created["invite_link"]).query)["token"][0]
        response = self.http.post(
            "/auth/invitations/accept",
            json={"token": token, "display_name": who.key, "password": who.password},
        )
        if response.status_code != 200:
            raise AssertionError(
                f"accept {who.key}: {response.status_code} {response.text}"
            )
        who.user_id = response.json()["user"]["id"]


def new_person(key: str, run: str) -> Person:
    return Person(
        key=key,
        email=f"{key}-{run}@example.com",
        password=secrets.token_urlsafe(18),
    )


def run_suffix() -> str:
    """Names that do not clash with a previous run on the same database."""
    return uuid.uuid4().hex[:8]


def ws_headers(who: Person) -> dict[str, str]:
    """As the desktop app sends them: the token in the handshake's header."""
    return dict(who.auth)


def event_of(message: str | bytes) -> dict[str, Any]:
    value = json.loads(message)
    return value if isinstance(value, dict) else {}
