"""``notifications/progress``: sent for a call that asked, never otherwise.

`mcp_tasks.progress` is what lets a tool say how far it got without knowing
its client. The rules it holds are the protocol's: a token is a string or an
integer, the values only go up, and a request without a token gets silence.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "backend"))

from mcp_tasks import (  # noqa: E402
    MODERN_VERSION,
    ToolServer,
    bind_progress,
    report_progress,
)


def test_nothing_is_sent_without_a_binding():
    report_progress(1, 2, "nobody listens")  # must not raise


@pytest.mark.parametrize("token", [None, "", True, 1.5, {"a": 1}])
def test_an_unusable_token_binds_nothing(token):
    sent: list[dict] = []
    with bind_progress(sent.append, token):
        report_progress(1)
    assert sent == []


def test_values_only_go_up_and_the_message_is_kept():
    sent: list[dict] = []
    with bind_progress(sent.append, 0):
        report_progress(3, 10, "a")
        report_progress(3, 10, "b")
        report_progress(2)
    values = [m["params"]["progress"] for m in sent]
    assert values[0] == 3 and values[1] > 3 and values[2] > values[1]
    assert sent[1]["params"]["message"] == "b"
    assert "total" not in sent[2]["params"] and "message" not in sent[2]["params"]
    assert all(m["params"]["progressToken"] == 0 for m in sent)
    assert all(m["method"] == "notifications/progress" for m in sent)


def test_a_vanished_client_does_not_fail_the_tool():
    def gone(_message):
        raise OSError("broken pipe")

    with bind_progress(gone, "t"):
        report_progress(1)


def _server(sent: list[dict] | None) -> ToolServer:
    async def call(name, arguments):
        report_progress(1, 2, "half way")
        return {"content": [{"type": "text", "text": "ok"}], "isError": False}

    server = ToolServer(
        name="t",
        version="1",
        instructions="",
        tools=[{"name": "slow", "inputSchema": {"type": "object"}}],
        call=call,
        legacy_versions=("2025-06-18",),
    )
    if sent is not None:
        server.notify = sent.append
    return server


@pytest.mark.parametrize("modern", [False, True])
def test_the_server_routes_the_token_of_the_call(modern):
    sent: list[dict] = []
    meta: dict = {"progressToken": "abc"}
    if modern:
        meta["io.modelcontextprotocol/protocolVersion"] = MODERN_VERSION
    message = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "slow", "arguments": {}, "_meta": meta},
    }
    reply = asyncio.run(_server(sent).handle(message))
    assert reply["result"]["content"][0]["text"] == "ok"
    assert [m["params"] for m in sent] == [
        {"progressToken": "abc", "progress": 1, "total": 2, "message": "half way"}
    ]


def test_a_transport_that_cannot_notify_stays_silent():
    message = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "slow", "arguments": {}, "_meta": {"progressToken": 1}},
    }
    reply = asyncio.run(_server(None).handle(message))
    assert reply["result"]["isError"] is False
