"""A local stand-in for the Windsurf language server.

`ConnectServer` listens on 127.0.0.1 and answers each RPC path from a queue of
scripted responses (the last one repeats), recording every request so a test
can decode what the client really sent. A response may be streamed in pieces
(chunked transfer) to exercise frame reassembly.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass
class Reply:
    status: int = 200
    body: bytes = b""
    content_type: str = "application/proto"
    #: Sent as separate chunks (chunked transfer), with a pause between them.
    pieces: list[bytes] | None = None
    delay: float = 0.0


@dataclass
class Request:
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class ConnectServer:
    port: int = 0
    routes: dict[str, list[Reply]] = field(default_factory=dict)
    requests: list[Request] = field(default_factory=list)

    def reply(self, path: str, *replies: Reply) -> None:
        self.routes[path] = list(replies)

    def bodies(self, path: str) -> list[bytes]:
        return [r.body for r in self.requests if r.path == path]

    def next_reply(self, path: str) -> Reply:
        queue = self.routes.get(path)
        if not queue:
            return Reply(status=404, body=b"no route")
        return queue.pop(0) if len(queue) > 1 else queue[0]


def _handler_for(server: ConnectServer):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):  # keep pytest output clean
            pass

        def do_POST(self):  # noqa: N802 - http.server naming
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length)
            server.requests.append(
                Request(
                    self.path, {k.lower(): v for k, v in self.headers.items()}, body
                )
            )
            reply = server.next_reply(self.path)
            if reply.delay:
                time.sleep(reply.delay)
            self.send_response(reply.status)
            self.send_header("content-type", reply.content_type)
            if reply.pieces is None:
                self.send_header("content-length", str(len(reply.body)))
                self.end_headers()
                self.wfile.write(reply.body)
                return
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for piece in reply.pieces:
                self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
                self.wfile.flush()
                time.sleep(0.05)
            self.wfile.write(b"0\r\n\r\n")

    return Handler


def start(state: ConnectServer) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(state))
    httpd.daemon_threads = True
    state.port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
