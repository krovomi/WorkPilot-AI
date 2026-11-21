"""The pair-programming panel's routes, on a room manager of their own."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def manager(monkeypatch: pytest.MonkeyPatch):
    import pair_realtime.api as api
    from pair_realtime.session import PairSessionManager

    fresh = PairSessionManager()
    monkeypatch.setattr(api, "_manager", fresh)
    return fresh


@pytest.fixture
def client(manager) -> TestClient:
    from pair_realtime.api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


ROOM = "/api/pair-realtime/rooms"


def test_a_room_is_created_listed_read_and_closed(client) -> None:
    created = client.post(ROOM, json={"room_id": "cart"}).json()
    assert created["success"] is True
    assert created["room"]["room_id"] == "cart"
    assert created["room"]["last_op_sequence"] == -1

    again = client.post(ROOM, json={"room_id": "cart"}).json()
    assert again["success"] is False and again["error"]

    assert client.get(ROOM).json() == {"success": True, "rooms": ["cart"]}
    assert client.get(f"{ROOM}/cart").json()["room"]["closed"] is False

    assert client.delete(f"{ROOM}/cart").json() == {"success": True, "closed": True}
    assert client.delete(f"{ROOM}/cart").json()["closed"] is False
    assert client.get(f"{ROOM}/cart").json() == {
        "success": False,
        "error": "unknown room 'cart'",
    }


def test_a_session_records_every_operation_in_order(client) -> None:
    joined = client.post(
        f"{ROOM}/cart/join",
        json={"user_id": "ana", "display_name": "Ana", "role": "DRIVER"},
    ).json()
    assert joined["success"] is True and joined["op"]["payload"]["role"] == "driver"

    edit = {"actor": "ana", "file_path": "cart.py", "start_line": 1, "end_line": 2}
    cursor = {"actor": "ana", "file_path": "cart.py", "line": 3, "column": 4}
    hint = {"actor": "ai", "file_path": "cart.py", "suggestion": "use a set"}
    for route, body in (
        ("edit", {**edit, "new_text": "total = 0\n"}),
        ("cursor", cursor),
        ("chat", {"actor": "ana", "text": "hello"}),
        ("suggestion", hint),
    ):
        assert client.post(f"{ROOM}/cart/{route}", json=body).json()["success"]

    left = client.post(f"{ROOM}/cart/leave", json={"user_id": "ana"}).json()
    assert left["op"]["kind"] == "leave"
    gone = client.post(f"{ROOM}/cart/leave", json={"user_id": "ana"}).json()
    assert gone == {"success": True, "op": None}

    ops = client.get(f"{ROOM}/cart/ops", params={"since_sequence": 1}).json()
    assert [o["kind"] for o in ops["ops"]] == [
        "edit",
        "cursor",
        "chat",
        "suggestion",
        "leave",
    ]
    assert ops["count"] == 5


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("join", {"user_id": "ana", "role": "boss"}),
        ("join", {"user_id": "ana"}),
    ],
)
def test_a_join_that_cannot_be_honoured_is_refused(client, route, body) -> None:
    room = "bad room" if "role" not in body else "cart"

    answer = client.post(f"{ROOM}/{room}/{route}", json=body).json()

    assert answer["success"] is False and answer["error"]


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("leave", {"user_id": "ana"}),
        ("edit", {"actor": "a", "file_path": "f", "start_line": 0, "end_line": 0}),
        ("cursor", {"actor": "a", "file_path": "f", "line": 0, "column": 0}),
        ("chat", {"actor": "a", "text": "hi"}),
        ("suggestion", {"actor": "a", "file_path": "f", "suggestion": "s"}),
    ],
)
def test_an_operation_on_an_unknown_room_is_refused(client, route, body) -> None:
    answer = client.post(f"{ROOM}/nowhere/{route}", json=body).json()

    assert answer["success"] is False
    assert client.get(f"{ROOM}/nowhere/ops").json()["success"] is False


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("edit", {"actor": "a", "file_path": "f", "start_line": 0, "end_line": 0}),
        ("cursor", {"actor": "a", "file_path": "f", "line": 0, "column": 0}),
        ("chat", {"actor": "a", "text": "hi"}),
        ("suggestion", {"actor": "a", "file_path": "f", "suggestion": "s"}),
    ],
)
def test_a_room_closed_while_an_operation_arrives_refuses_it(
    client, manager, route, body
) -> None:
    # The window between `get_room` and the write: the room is still listed,
    # already closed.
    manager.create_room("cart").close()

    answer = client.post(f"{ROOM}/cart/{route}", json=body).json()

    assert answer["success"] is False and answer["error"]


def test_a_stream_of_an_unknown_room_says_so_and_ends(client) -> None:
    with client.stream("GET", f"{ROOM}/nowhere/stream") as response:
        body = response.read().decode("utf-8")

    assert body.startswith("event: error\n")
    assert json.loads(body.split("data: ", 1)[1]) == {"error": "unknown room 'nowhere'"}


async def test_a_stream_replays_the_backlog_then_follows_the_room(manager) -> None:
    from pair_realtime.api import stream

    room = manager.create_room("cart")
    room.submit_chat("ana", "first")

    response = await stream("cart", since_sequence=0)
    events = response.body_iterator

    replayed = await anext(events)
    assert json.loads(replayed.removeprefix("data: "))["payload"] == {"text": "first"}

    waiting = asyncio.ensure_future(anext(events))
    await asyncio.sleep(0)
    room.submit_chat("ana", "second")
    live = await asyncio.wait_for(waiting, timeout=5)
    assert json.loads(live.removeprefix("data: "))["payload"] == {"text": "second"}

    # The client leaves: the subscription ends without an error.
    leaving = asyncio.ensure_future(anext(events))
    await asyncio.sleep(0)
    leaving.cancel()
    with pytest.raises(StopAsyncIteration):
        await leaving
