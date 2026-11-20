"""The filtering proxy on every path a request can take.

`test_proxy.py` covers an allowed host reached directly and another refused.
This file covers the rest, with real sockets: a request the proxy cannot
read, a target it cannot parse, an allowed host it cannot reach, the
machine's own proxy that it chains through (and that may refuse), the Unix
socket it listens on inside a Linux sandbox, and the per-process proxies.
"""

from __future__ import annotations

import asyncio
import http.server
import shutil
import socket
import stat
import tempfile
import threading
import time
import types
from pathlib import Path

import pytest
from foundation.platform import is_windows
from os_sandbox import proxy as proxy_module
from os_sandbox.hosts import HostAllowlist
from os_sandbox.proxy import FilteringProxy, shared_proxy


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


def _settled(proxy: FilteringProxy) -> None:
    """Wait until the proxy has finished every connection it was handling.

    Only the connection handlers count: on Windows the proactor keeps a task
    of its own pending on every listening socket (its `accept`), forever.
    """

    async def others() -> int:
        return sum(
            getattr(task.get_coro(), "__qualname__", "") == "FilteringProxy._handle"
            for task in asyncio.all_tasks()
        )

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        future = asyncio.run_coroutine_threadsafe(others(), proxy._loop)
        if future.result(5) == 0:
            return
        time.sleep(0.02)
    raise AssertionError("the proxy kept a connection open")


def _ask(port: int, request: bytes) -> bytes:
    """Send `request`, read until the proxy closes; a reset reads as silence."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as conn:
        try:
            conn.sendall(request)
            chunks = []
            while chunk := conn.recv(65536):
                chunks.append(chunk)
        except OSError:
            return b""
        return b"".join(chunks)


def _through_tunnel(port: int, target: str, path: str) -> tuple[bytes, bytes]:
    """CONNECT to `target`, then GET `path` inside; the two answers."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as conn:
        conn.sendall(f"CONNECT {target} HTTP/1.1\r\n\r\n".encode())
        established = conn.recv(4096)
        if not established.startswith(b"HTTP/1.1 200"):
            return established, b""
        conn.sendall(
            f"GET {path} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n".encode()
        )
        data = b""
        while chunk := conn.recv(65536):
            data += chunk
        return established, data


@pytest.fixture
def direct(origin):
    proxy = FilteringProxy(HostAllowlist.build([f"127.0.0.1:{origin}"]), unix_dir=None)
    yield proxy
    proxy.close()


class TestRequestsItCannotRead:
    @pytest.mark.parametrize(
        "request_bytes",
        [
            b"GARBAGE\r\n\r\n",
            b"CONNECT :443 HTTP/1.1\r\n\r\n",
            b"CONNECT a.org:99999 HTTP/1.1\r\n\r\n",
            b"CONNECT a.org:https HTTP/1.1\r\n\r\n",
            b"GET http://:80/ HTTP/1.1\r\n\r\n",
        ],
    )
    def test_a_request_line_or_target_it_cannot_parse_is_answered_400(
        self, direct, request_bytes
    ):
        assert _ask(direct.port, request_bytes).startswith(b"HTTP/1.1 400")

    def test_a_client_that_hangs_up_mid_request_gets_nothing(self, direct):
        with socket.create_connection(("127.0.0.1", direct.port), timeout=10) as conn:
            conn.sendall(b"GET http://a.org/ HTTP/1.1\r\n")
            conn.shutdown(socket.SHUT_WR)
            assert conn.recv(4096) == b""
        _settled(direct)

    def test_a_head_past_the_reader_s_limit_is_dropped(self, direct):
        assert (
            _ask(direct.port, b"GET http://a.org/ HTTP/1.1\r\nX: " + b"a" * 70000)
            == b""
        )
        _settled(direct)

    def test_a_head_just_past_its_size_limit_is_answered_431(self, direct):
        prefix = b"GET http://a.org/ HTTP/1.1\r\nX: "
        # The blank line starts right at the reader's limit: read, then refused.
        head = prefix + b"a" * (proxy_module._MAX_HEAD - len(prefix)) + b"\r\n\r\n"

        assert _ask(direct.port, head).startswith(b"HTTP/1.1 431")


class TestTargets:
    def test_a_bracketed_ipv6_target_is_checked_on_its_address(self, direct):
        answer = _ask(direct.port, b"CONNECT [::1]:22 HTTP/1.1\r\n\r\n")

        assert answer.startswith(b"HTTP/1.1 403")
        assert (
            direct.refusals_since(0)[-1].host,
            direct.refusals_since(0)[-1].port,
        ) == (
            "::1",
            22,
        )

    def test_an_allowed_host_that_does_not_answer_is_a_bad_gateway(self):
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
        probe.close()
        proxy = FilteringProxy(
            HostAllowlist.build([f"127.0.0.1:{closed_port}"]), unix_dir=None
        )
        try:
            answer = _ask(
                proxy.port, f"CONNECT 127.0.0.1:{closed_port} HTTP/1.1\r\n\r\n".encode()
            )
        finally:
            proxy.close()

        assert answer.startswith(b"HTTP/1.1 502")

    def test_a_finished_tunnel_closes_both_sides(self, direct, origin):
        established, data = _through_tunnel(direct.port, f"127.0.0.1:{origin}", "/t")

        assert established.startswith(b"HTTP/1.1 200")
        assert data.endswith(b"hello /t")
        _settled(direct)

    def test_a_forwarded_request_drops_the_proxy_headers(self, origin):
        seen: list[str] = []

        class Echo(_Hello):
            def do_GET(self):  # noqa: N802 - the stdlib's name
                seen.extend(self.headers.keys())
                super().do_GET()

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_address[1]
        proxy = FilteringProxy(
            HostAllowlist.build([f"127.0.0.1:{port}"]), unix_dir=None
        )
        try:
            answer = _ask(
                proxy.port,
                f"GET http://user@127.0.0.1:{port}/f HTTP/1.1\r\nHost: a\r\n"
                "Proxy-Authorization: x\r\nKeep-Alive: 5\r\nConnection: keep-alive\r\n"
                "Accept: */*\r\n\r\n".encode(),
            )
            _settled(proxy)
        finally:
            proxy.close()
            server.shutdown()

        assert answer.endswith(b"hello /f")
        assert "Accept" in seen and "Proxy-Authorization" not in seen
        assert "Keep-Alive" not in seen
        assert [h for h in seen if h.lower() == "connection"] == ["Connection"]


@pytest.fixture
def machine_proxy(origin):
    """The machine's own proxy: answers each CONNECT with `status`, then relays
    to the origin whatever the target named."""
    state = types.SimpleNamespace(status=b"200 Connection Established", targets=[])
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(8)

    def pump(source, target):
        try:
            while chunk := source.recv(65536):
                target.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                target.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def handle(conn):
        with conn:
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                head += chunk
            state.targets.append(head.split(b" ")[1].decode())
            conn.sendall(b"HTTP/1.1 " + state.status + b"\r\n\r\n")
            if not state.status.startswith(b"200"):
                return
            with socket.create_connection(("127.0.0.1", origin), timeout=10) as up:
                upstream = threading.Thread(target=pump, args=(conn, up), daemon=True)
                upstream.start()
                pump(up, conn)
                upstream.join(10)

    def serve():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    state.address = server.getsockname()
    yield state
    server.close()


@pytest.fixture
def chained(machine_proxy):
    proxy = FilteringProxy(
        HostAllowlist.build(["origin.test"]),
        unix_dir=None,
        upstream=machine_proxy.address,
    )
    yield proxy
    proxy.close()


class TestMachineProxy:
    def test_a_tunnel_goes_through_the_machine_s_proxy(self, chained, machine_proxy):
        established, data = _through_tunnel(chained.port, "origin.test:443", "/c")

        assert established.startswith(b"HTTP/1.1 200")
        assert data.endswith(b"hello /c")
        assert machine_proxy.targets == ["origin.test:443"]

    def test_a_plain_request_goes_through_it_too(self, chained, machine_proxy):
        answer = _ask(
            chained.port, b"GET http://origin.test/p HTTP/1.1\r\nHost: a\r\n\r\n"
        )

        assert answer.endswith(b"hello /p")
        assert machine_proxy.targets == ["origin.test:80"]

    def test_a_tunnel_the_machine_s_proxy_refuses_is_a_bad_gateway(
        self, chained, machine_proxy
    ):
        machine_proxy.status = b"407 Proxy Authentication Required"

        established, _ = _through_tunnel(chained.port, "origin.test:443", "/r")

        assert established.startswith(b"HTTP/1.1 502")

    def test_a_loopback_host_is_reached_directly(self, machine_proxy, origin):
        proxy = FilteringProxy(
            HostAllowlist.build([f"127.0.0.1:{origin}"]),
            unix_dir=None,
            upstream=machine_proxy.address,
        )
        try:
            _, data = _through_tunnel(proxy.port, f"127.0.0.1:{origin}", "/l")
        finally:
            proxy.close()

        assert data.endswith(b"hello /l")
        assert machine_proxy.targets == []


class _Reader:
    def __init__(self, error: BaseException):
        self.error = error

    async def read(self, _size):
        raise self.error


class _Writer:
    def __init__(self, eof: bool):
        self.eof = eof
        self.wrote_eof = False

    def can_write_eof(self):
        return self.eof

    def write_eof(self):
        self.wrote_eof = True


class TestPipe:
    def test_a_reset_side_ends_the_pipe_and_ends_the_other_s_writes(self):
        writer = _Writer(eof=True)

        asyncio.run(proxy_module._pipe(_Reader(ConnectionResetError()), writer))  # type: ignore[arg-type]

        assert writer.wrote_eof

    def test_a_writer_that_cannot_half_close_is_left_to_the_close(self):
        writer = _Writer(eof=False)

        asyncio.run(proxy_module._pipe(_Reader(TimeoutError()), writer))  # type: ignore[arg-type]

        assert not writer.wrote_eof


class TestStarting:
    def test_a_listener_that_cannot_start_raises_in_the_caller(self, tmp_path):
        blocker = tmp_path / "a-file"
        blocker.write_text("", encoding="utf-8")

        with pytest.raises(OSError):
            FilteringProxy(HostAllowlist.build([]), unix_dir=blocker)

    def test_a_listener_that_never_binds_is_refused(self, monkeypatch):
        async def nothing(self, _unix_dir):
            return None

        monkeypatch.setattr(FilteringProxy, "_listen", nothing)

        with pytest.raises(RuntimeError, match="did not start"):
            FilteringProxy(HostAllowlist.build([]), unix_dir=None)


@pytest.fixture
def short_dir():
    """A folder short enough for a Unix socket path.

    macOS caps the path at 104 bytes, and pytest's ``tmp_path`` there
    (``/private/var/folders/…``) is longer than that.
    """
    folder = Path(tempfile.mkdtemp(prefix="wp-proxy-", dir="/tmp"))
    yield folder
    shutil.rmtree(folder, ignore_errors=True)


@pytest.mark.skipif(is_windows(), reason="the Unix socket is the Linux sandbox's door")
class TestUnixSocket:
    def test_the_socket_is_private_and_answers_then_is_removed(self, short_dir, origin):
        proxy = FilteringProxy(
            HostAllowlist.build([f"127.0.0.1:{origin}"]), unix_dir=short_dir / "s"
        )
        path = proxy.socket_path
        assert path is not None and path.parent == short_dir / "s"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(10)
            conn.connect(str(path))
            conn.sendall(f"GET http://127.0.0.1:{origin}/u HTTP/1.1\r\n\r\n".encode())
            data = b""
            while chunk := conn.recv(65536):
                data += chunk
        proxy.close()

        assert data.endswith(b"hello /u")
        assert not path.exists()

    def test_a_socket_already_removed_is_no_error_on_close(self, short_dir):
        proxy = FilteringProxy(HostAllowlist.build([]), unix_dir=short_dir)
        assert proxy.socket_path is not None
        proxy.socket_path.unlink()

        proxy.close()


class TestSharedProxies:
    def test_one_proxy_per_allowlist_and_listener_kind_until_exit(self, monkeypatch):
        monkeypatch.setattr(proxy_module, "_proxies", {})
        monkeypatch.setattr(proxy_module, "upstream_proxy", lambda: None)
        allow = HostAllowlist.build(["a.org"])

        first = shared_proxy(allow, unix_dir=None)
        again = shared_proxy(HostAllowlist.build(["a.org"]), unix_dir=None)
        other = shared_proxy(HostAllowlist.build(["b.org"]), unix_dir=None)

        assert first is again and other is not first
        proxy_module._close_all()
        assert proxy_module._proxies == {}
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", first.port), timeout=2).close()
