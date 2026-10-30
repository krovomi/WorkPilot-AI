"""The filtering proxy that is a sandboxed process's only way out.

A sandboxed process has no network of its own (Linux: a fresh network
namespace; macOS: Seatbelt allows only the proxy's loopback port). It is
given ``HTTPS_PROXY`` / ``HTTP_PROXY`` pointing here, and this proxy opens a
connection only to a host its allowlist names:

- ``CONNECT host:port`` (HTTPS, and anything tunnelled): checked on the
  host and port the client asks for; the TLS inside is never opened.
- ``GET http://host/...`` (plain HTTP, absolute form): checked the same way,
  then the request is forwarded in origin form and the connection is
  closed after the answer, so a second request on it cannot name another
  host.

A refused host is answered 403 and recorded (`refusals_since`), so the feed
can say which host was blocked instead of leaving a timeout to guess from.

One proxy per allowlist and process, on its own thread and event loop. On
Linux it listens on a Unix socket (0600) that the sandbox binds in; on macOS
on an ephemeral loopback port.
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import logging
import os
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .hosts import HostAllowlist, normalize_host

logger = logging.getLogger(__name__)

_MAX_HEAD = 64 * 1024
_CONNECT_TIMEOUT = 20.0
_IDLE_TIMEOUT = 300.0


def upstream_proxy(env: Mapping[str, str] | None = None) -> tuple[str, int] | None:
    """The machine's own HTTP proxy, which this one connects through.

    Read from ``HTTPS_PROXY`` (then ``HTTP_PROXY``) of the WorkPilot process,
    as any other client on the machine would; only an ``http://`` proxy is
    chained. Credentials in the URL are not supported and the proxy is then
    not used: a refused tunnel says so rather than leaking them in a log.
    """
    source: Mapping[str, str] = os.environ if env is None else env
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = (source.get(name) or "").strip()
        if not value:
            continue
        parsed = urlsplit(value if "://" in value else f"http://{value}")
        if parsed.scheme != "http" or parsed.username or not parsed.hostname:
            return None
        return parsed.hostname, parsed.port or 80
    return None


@dataclass(frozen=True)
class Refusal:
    at: float
    host: str
    port: int


def _split_target(target: str, default_port: int) -> tuple[str, int] | None:
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        port_text = rest[1:] if rest.startswith(":") else ""
    elif target.count(":") == 1:
        host, _, port_text = target.partition(":")
    else:
        host, port_text = target, ""
    if not host:
        return None
    if not port_text:
        return host, default_port
    if not port_text.isdigit() or not 0 < int(port_text) < 65536:
        return None
    return host, int(port_text)


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), _IDLE_TIMEOUT)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (TimeoutError, ConnectionError, OSError):
        # An idle, reset or closed side ends the tunnel; the finally closes both.
        pass
    finally:
        with contextlib.suppress(Exception):
            if writer.can_write_eof():
                writer.write_eof()


async def _close(writer: asyncio.StreamWriter) -> None:
    with contextlib.suppress(Exception):
        writer.close()
        await writer.wait_closed()


class FilteringProxy:
    def __init__(
        self,
        allowlist: HostAllowlist,
        *,
        unix_dir: Path | None,
        upstream: tuple[str, int] | None = None,
    ) -> None:
        self.allowlist = allowlist
        self.upstream = upstream
        self._refusals: list[Refusal] = []
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._server: asyncio.AbstractServer | None = None
        self.socket_path: Path | None = None
        self.port: int | None = None
        ready = threading.Event()
        failure: list[BaseException] = []

        def run() -> None:
            asyncio.set_event_loop(self._loop)
            try:
                self._loop.run_until_complete(self._listen(unix_dir))
            # Reported to the starting thread, cancellation included.
            except (Exception, asyncio.CancelledError) as error:
                failure.append(error)
                ready.set()
                return
            ready.set()
            self._loop.run_forever()

        self._thread = threading.Thread(
            target=run, name="workpilot-sandbox-proxy", daemon=True
        )
        self._thread.start()
        ready.wait(10)
        if failure:
            raise failure[0]
        if self._server is None:
            raise RuntimeError("the sandbox proxy did not start")

    async def _listen(self, unix_dir: Path | None) -> None:
        if unix_dir is not None:
            unix_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = unix_dir / f"proxy-{uuid.uuid4().hex[:12]}.sock"
            old_umask = os.umask(0o177)
            try:
                self._server = await asyncio.start_unix_server(
                    self._handle, path=str(path)
                )
            finally:
                os.umask(old_umask)
            self.socket_path = path
        else:
            self._server = await asyncio.start_server(
                self._handle, host="127.0.0.1", port=0
            )
            self.port = self._server.sockets[0].getsockname()[1]

    # ── refusals ──────────────────────────────────────────────────────────
    def _refuse(self, host: str, port: int) -> None:
        with self._lock:
            self._refusals.append(Refusal(time.time(), host, port))
            del self._refusals[:-200]

    def refusals_since(self, since: float) -> list[Refusal]:
        with self._lock:
            return [r for r in self._refusals if r.at >= since]

    # ── one client connection ─────────────────────────────────────────────
    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            head = await asyncio.wait_for(
                reader.readuntil(b"\r\n\r\n"), _CONNECT_TIMEOUT
            )
        except (
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
            TimeoutError,
            OSError,
        ):
            await _close(writer)
            return
        if len(head) > _MAX_HEAD:
            await self._answer(writer, 431, "Request Header Fields Too Large")
            return
        try:
            request_line, *header_lines = head.decode("latin-1").split("\r\n")
            method, target, version = request_line.split(" ", 2)
        except ValueError:
            await self._answer(writer, 400, "Bad Request")
            return
        if method.upper() == "CONNECT":
            await self._tunnel(target, reader, writer)
        else:
            await self._forward(method, target, version, header_lines, reader, writer)

    async def _answer(
        self, writer: asyncio.StreamWriter, status: int, reason: str, body: str = ""
    ) -> None:
        payload = body.encode()
        with contextlib.suppress(Exception):
            writer.write(
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\n"
                f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
                + payload
            )
            await writer.drain()
        await _close(writer)

    async def _open(self, host: str, port: int, writer: asyncio.StreamWriter):
        if not self.allowlist.allows(host, port):
            self._refuse(host, port)
            await self._answer(
                writer,
                403,
                "Forbidden",
                f"WorkPilot sandbox: {host}:{port} is not on this task's network allowlist.\n",
            )
            return None
        try:
            if self.upstream is None or self._loopback(host):
                return await asyncio.wait_for(
                    asyncio.open_connection(host, port), _CONNECT_TIMEOUT
                )
            return await asyncio.wait_for(
                self._via_upstream(host, port), _CONNECT_TIMEOUT
            )
        except (OSError, TimeoutError, ConnectionError):
            await self._answer(writer, 502, "Bad Gateway")
            return None

    @staticmethod
    def _loopback(host: str) -> bool:
        normalized = normalize_host(host) or ""
        return normalized in ("localhost", "::1") or normalized.startswith("127.")

    async def _via_upstream(self, host: str, port: int):
        """A tunnel to `host:port` opened through the machine's proxy."""
        assert self.upstream is not None
        reader, writer = await asyncio.open_connection(*self.upstream)
        target = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        writer.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        status = head.split(b" ", 2)[1:2]
        if status != [b"200"]:
            await _close(writer)
            raise ConnectionError(f"upstream proxy refused {target}")
        return reader, writer

    async def _tunnel(self, target: str, reader, writer) -> None:
        parts = _split_target(target, 443)
        if parts is None:
            await self._answer(writer, 400, "Bad Request")
            return
        upstream = await self._open(*parts, writer)
        if upstream is None:
            return
        up_reader, up_writer = upstream
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))
        await _close(up_writer)
        await _close(writer)

    async def _forward(
        self, method, target, version, header_lines, reader, writer
    ) -> None:
        if not target.lower().startswith("http://"):
            await self._answer(writer, 400, "Bad Request")
            return
        rest = target[len("http://") :]
        authority, slash, path = rest.partition("/")
        parts = _split_target(authority.rpartition("@")[2], 80)
        if parts is None:
            await self._answer(writer, 400, "Bad Request")
            return
        upstream = await self._open(*parts, writer)
        if upstream is None:
            return
        up_reader, up_writer = upstream
        kept = [
            line
            for line in header_lines
            if line
            and not line.lower().startswith(("proxy-", "connection:", "keep-alive:"))
        ]
        head = (
            f"{method} {slash}{path or ''} {version}\r\n"
            + "".join(f"{line}\r\n" for line in kept)
            + "Connection: close\r\n\r\n"
        )
        up_writer.write(head.encode("latin-1"))
        await up_writer.drain()
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))
        await _close(up_writer)
        await _close(writer)

    def close(self) -> None:
        def stop() -> None:
            if self._server is not None:
                self._server.close()
            self._loop.stop()

        with contextlib.suppress(RuntimeError):
            self._loop.call_soon_threadsafe(stop)
        self._thread.join(5)
        if self.socket_path is not None:
            with contextlib.suppress(OSError):
                self.socket_path.unlink()


_proxies: dict[tuple[HostAllowlist, bool], FilteringProxy] = {}
_proxies_lock = threading.Lock()


def shared_proxy(allowlist: HostAllowlist, *, unix_dir: Path | None) -> FilteringProxy:
    """The process's proxy for this allowlist, started on first use."""
    key = (allowlist, unix_dir is not None)
    with _proxies_lock:
        proxy = _proxies.get(key)
        if proxy is None:
            proxy = FilteringProxy(
                allowlist, unix_dir=unix_dir, upstream=upstream_proxy()
            )
            _proxies[key] = proxy
        return proxy


@atexit.register
def _close_all() -> None:
    with _proxies_lock:
        for proxy in _proxies.values():
            proxy.close()
        _proxies.clear()
