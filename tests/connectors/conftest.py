"""
pytest configuration for connector tests
"""

import importlib.util
import json
import sys
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

# Add the project root to the Python path for connector tests
# When pytest runs tests in subdirectories, it needs explicit path configuration
current_dir = Path(__file__).parent
project_root = (
    current_dir.parent.parent.parent
)  # Go up from tests/connectors to project root
src_path = project_root / "src"

# Use absolute paths from the file location
conftest_file = Path(__file__).resolve()
project_root_abs = conftest_file.parent.parent.parent
src_path_abs = project_root_abs / "src"

# Ensure paths are in sys.path in correct order
# First add project root, then src, so src ends up first
if str(project_root_abs) not in sys.path:
    sys.path.insert(0, str(project_root_abs))
if str(src_path_abs) not in sys.path:
    sys.path.insert(0, str(src_path_abs))

print(f"Connector tests - Python path includes: {project_root_abs}")
print(f"Connector tests - Python path includes: {src_path_abs}")


# Helper function to import modules directly, bypassing __init__.py circular imports
def import_module_direct(module_name, file_path):
    """Import a module directly from file path, bypassing package __init__.py"""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# ── A local HTTP server standing in for a SaaS API ──────────────────


@dataclass
class Reply:
    status: int = 200
    body: Any = None
    raw: bytes | None = None


@dataclass
class FakeApi:
    """Scripted answers per (method, path); every request is recorded."""

    url: str = ""
    routes: dict[tuple[str, str], Reply] = field(default_factory=dict)
    seen: list[dict[str, Any]] = field(default_factory=list)

    def answer(self, method: str, path: str, body: Any = None, status: int = 200):
        self.routes[(method, path)] = Reply(status=status, body=body)

    def answer_raw(self, method: str, path: str, raw: bytes, status: int):
        self.routes[(method, path)] = Reply(status=status, raw=raw)

    def last(self, method: str, path: str) -> dict[str, Any]:
        return [r for r in self.seen if (r["method"], r["path"]) == (method, path)][-1]


@pytest.fixture
def fake_api() -> Iterator[FakeApi]:
    """A real HTTP server on 127.0.0.1; unknown routes answer 404."""
    fake = FakeApi()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def _serve(self) -> None:
            parts = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            payload = self.rfile.read(length) if length else b""
            fake.seen.append(
                {
                    "method": self.command,
                    "path": parts.path,
                    "query": {k: v[0] for k, v in parse_qs(parts.query).items()},
                    "json": json.loads(payload) if payload else None,
                    "headers": dict(self.headers),
                    "auth": self.headers.get("Authorization"),
                }
            )
            reply = fake.routes.get((self.command, parts.path), Reply(status=404))
            if reply.raw is not None:
                data = reply.raw
            elif reply.body is None:
                data = b""
            else:
                data = json.dumps(reply.body).encode("utf-8")
            self.send_response(reply.status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = _serve

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()
