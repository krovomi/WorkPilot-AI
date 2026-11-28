"""``flags.send`` against local HTTP servers: the status, and a redirect kept as the answer."""

from __future__ import annotations

import http.server
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from release_coordinator.flags import FlagRequest, send


@contextmanager
def _server(handler: type[http.server.BaseHTTPRequestHandler]) -> Iterator[str]:
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _request(url: str, method: str = "PATCH") -> FlagRequest:
    return FlagRequest(method, f"{url}/flag", {"Authorization": "Bearer t-0000"}, b"{}")


class _Quiet(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def send_response(self, code: int, message: str | None = None) -> None:
        # Read the body before answering: a socket closed with unread data
        # is reset on Windows, and the client then sees no answer at all.
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        super().send_response(code, message)


def test_send_returns_the_status_the_provider_answered() -> None:
    class Ok(_Quiet):
        def do_PATCH(self) -> None:
            self.send_response(204)
            self.end_headers()

    with _server(Ok) as url:
        assert send(_request(url)) == 204


def test_send_keeps_a_redirect_as_the_answer_and_follows_nothing() -> None:
    seen: list[str] = []

    class Elsewhere(_Quiet):
        def do_PATCH(self) -> None:
            seen.append(self.headers.get("Authorization", ""))
            self.send_response(200)
            self.end_headers()

        do_GET = do_PATCH

    with _server(Elsewhere) as other:

        class Moved(_Quiet):
            def do_POST(self) -> None:
                self.send_response(302)
                self.send_header("Location", f"{other}/flag")
                self.end_headers()

        with _server(Moved) as url:
            assert send(_request(url, "POST")) == 302
    assert seen == []


def test_send_answers_zero_when_nothing_answers() -> None:
    with _server(_Quiet) as url:
        pass
    assert send(_request(url)) == 0
