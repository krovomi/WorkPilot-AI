"""The local API answers only requests addressed to this machine."""

from __future__ import annotations

import pytest
from foundation.loopback_host import LoopbackHostOnly, host_name, origin_hosts
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


async def _hello(_request):
    return PlainTextResponse("hello")


async def _socket(websocket):
    await websocket.accept()
    await websocket.send_text("hello")
    await websocket.close()


def _client(extra_origins=()) -> TestClient:
    app = Starlette(routes=[Route("/", _hello), WebSocketRoute("/ws", _socket)])
    app.add_middleware(LoopbackHostOnly, extra_origins=extra_origins)
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.mark.parametrize(
    "header",
    [
        "127.0.0.1",
        "127.0.0.1:9000",
        "localhost:9000",
        "LOCALHOST",
        "localhost.",
        "[::1]:9000",
        "[::1]",
    ],
)
def test_a_request_to_this_machine_is_answered(header):
    response = _client().get("/", headers={"host": header})

    assert (response.status_code, response.text) == (200, "hello")


@pytest.mark.parametrize(
    "header",
    [
        "example.com",
        "example.com:9000",
        "localhost.example.com",
        "127.0.0.1.example.com",
        "10.0.0.5:9000",
        "[::2]:9000",
        "[::1",
        "",
    ],
)
def test_a_request_to_another_host_is_refused_before_any_route(header):
    response = _client().get("/", headers={"host": header})

    assert response.status_code == 421
    assert response.text == "Misdirected request"


def test_an_origin_opted_into_adds_its_host():
    client = _client(extra_origins=["http://devbox.lan:5173", "not a url", "::"])

    assert client.get("/", headers={"host": "devbox.lan:9000"}).status_code == 200
    assert client.get("/", headers={"host": "other.lan"}).status_code == 421


def test_a_request_without_a_host_is_answered():
    seen = []

    async def app(scope, receive, send):
        seen.append(scope["type"])

    middleware = LoopbackHostOnly(app)
    import asyncio

    asyncio.run(middleware({"type": "http", "headers": []}, None, None))
    asyncio.run(middleware({"type": "lifespan"}, None, None))

    assert seen == ["http", "lifespan"]


def test_a_socket_to_this_machine_opens():
    with _client().websocket_connect(
        "/ws", headers={"host": "localhost:9000"}
    ) as socket:
        assert socket.receive_text() == "hello"


def test_a_socket_to_another_host_is_closed():
    with pytest.raises(WebSocketDisconnect) as closed:
        with _client().websocket_connect("/ws", headers={"host": "example.com"}):
            pass

    assert closed.value.code == 1008


def test_host_name_and_origin_hosts():
    assert host_name(" Example.COM:80 ") == "example.com"
    assert host_name("[fe80::1]:9000") == "fe80::1"
    # A bare IPv6 address without brackets keeps all its colons.
    assert host_name("::1") == "::1"
    assert origin_hosts(["https://A.example:1/", "http://[::1]:2", "http://[x"]) == {
        "a.example",
        "::1",
    }


def test_the_local_api_refuses_another_host():
    import provider_api

    client = TestClient(provider_api.app, base_url="http://127.0.0.1")

    refused = client.get("/api/hooks/stats", headers={"host": "example.com:9000"})
    answered = client.get("/api/hooks/stats")

    assert refused.status_code == 421
    assert answered.status_code != 421
