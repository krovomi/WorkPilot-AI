"""The filtering proxy: an allowed host is reached, any other is refused and named."""

from __future__ import annotations

import http.server
import socket
import threading

import pytest
from os_sandbox.hosts import HostAllowlist
from os_sandbox.proxy import FilteringProxy, upstream_proxy


class _Hello(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - the stdlib's name
        body = f"hello {self.path}".encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def origin():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Hello)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()


@pytest.fixture
def proxy(origin):
    proxy = FilteringProxy(HostAllowlist.build([f"127.0.0.1:{origin}"]), unix_dir=None)
    yield proxy
    proxy.close()


def _ask(proxy: FilteringProxy, request: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as conn:
        conn.sendall(request)
        chunks = []
        while chunk := conn.recv(65536):
            chunks.append(chunk)
            if request.startswith(b"CONNECT") and b"\r\n\r\n" in b"".join(chunks):
                break
        return b"".join(chunks)


def test_a_plain_request_to_an_allowed_host_is_forwarded(proxy, origin):
    answer = _ask(
        proxy, f"GET http://127.0.0.1:{origin}/x HTTP/1.1\r\nHost: a\r\n\r\n".encode()
    )
    assert answer.startswith(b"HTTP/1.0 200") or answer.startswith(b"HTTP/1.1 200")
    assert answer.endswith(b"hello /x")


def test_a_tunnel_to_an_allowed_host_carries_the_bytes(proxy, origin):
    with socket.create_connection(("127.0.0.1", proxy.port), timeout=10) as conn:
        conn.sendall(f"CONNECT 127.0.0.1:{origin} HTTP/1.1\r\n\r\n".encode())
        assert conn.recv(4096).startswith(b"HTTP/1.1 200")
        conn.sendall(b"GET /tunnel HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n")
        data = b""
        while chunk := conn.recv(65536):
            data += chunk
    assert data.endswith(b"hello /tunnel")


@pytest.mark.parametrize(
    "request_line",
    [
        "CONNECT example.com:443 HTTP/1.1",
        "GET http://example.com/ HTTP/1.1",
        "CONNECT 127.0.0.1:22 HTTP/1.1",
    ],
)
def test_any_other_host_is_refused_and_recorded(proxy, request_line):
    answer = _ask(proxy, f"{request_line}\r\nHost: x\r\n\r\n".encode())
    assert answer.startswith(b"HTTP/1.1 403")
    refused = proxy.refusals_since(0)
    assert refused and refused[-1].host in ("example.com", "127.0.0.1")


def test_a_malformed_request_is_refused(proxy):
    assert _ask(proxy, b"GET /relative HTTP/1.1\r\n\r\n").startswith(b"HTTP/1.1 400")


def test_the_machines_proxy_is_chained_only_when_it_is_plain_http():
    assert upstream_proxy({"HTTPS_PROXY": "http://proxy.corp:3128"}) == (
        "proxy.corp",
        3128,
    )
    assert upstream_proxy({"https_proxy": "proxy.corp:8080"}) == ("proxy.corp", 8080)
    assert upstream_proxy({"HTTPS_PROXY": "https://proxy.corp"}) is None
    # Credentials would end up in the tunnel request; not chained.
    assert (
        upstream_proxy({"HTTPS_PROXY": "http://u:p@proxy.corp:3128"}) is None
    )  # pragma: allowlist secret
    assert upstream_proxy({}) is None
