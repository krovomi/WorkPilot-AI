"""The Connect-protocol chat client (`windsurf_proxy/grpc_client.py`).

Requests are decoded field by field with the Cascade client's own protobuf
reader; responses come from a local server (`conftest.ConnectServer`) that
streams real Connect frames, so frame reassembly, trailers and HTTP errors are
the code's own handling, not a mock's.
"""

from __future__ import annotations

import asyncio
import builtins
import json
import socket
import struct

import pytest
from integrations.windsurf_proxy import grpc_client as g
from integrations.windsurf_proxy.auth import WindsurfError, WindsurfErrorCode
from integrations.windsurf_proxy.cascade_client import (
    _get_all_fields,
    _get_field,
    _parse_fields,
)

from tests.integrations.windsurf_proxy.connect_fake import Reply


def _frame(payload: bytes, flags: int = 0) -> bytes:
    return struct.pack(">BI", flags, len(payload)) + payload


def _text_frame(text: str) -> bytes:
    """A RawGetChatMessageResponse whose delta_message carries `text`."""
    raw_chat = (
        g._encode_string_field(1, "msg-1")
        + g._encode_varint_field(2, g.SOURCE_ASSISTANT)
        + g._encode_string_field(5, text)
    )
    return _frame(g._encode_bytes_field(1, raw_chat))


def _trailer(error: dict | None = None) -> bytes:
    return _frame(json.dumps({"error": error} if error else {}).encode(), flags=0x02)


def _block_httpx_import(monkeypatch):
    real_import = builtins.__import__

    def fake(name, *args, **kwargs):
        if name == "httpx":
            raise ImportError("no httpx")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake)


# --------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [0, 1, 127, 128, 300, 2**31, 2**63 - 1])
def test_varint_round_trips(value):
    encoded = g._encode_varint(value)
    assert g._decode_varint(encoded, 0) == (value, len(encoded))


def test_varint_known_bytes_and_tags():
    assert g._encode_varint(300) == b"\xac\x02"
    assert g._encode_tag(1, g.WIRE_LENGTH_DELIMITED) == b"\x0a"
    assert g._encode_string_field(2, "hé") == b"\x12\x03h\xc3\xa9"
    assert g._encode_varint_field(4, 5) == b"\x20\x05"


def test_timestamp_is_seconds_then_nanos(monkeypatch):
    monkeypatch.setattr(g.time, "time", lambda: 1_700_000_000.25)
    fields = _parse_fields(g._encode_timestamp())
    assert _get_field(fields, 1, 0) == 1_700_000_000
    assert _get_field(fields, 2, 0) == 250_000_000


def test_frame_is_flag_length_payload():
    assert g._frame_grpc_message(b"abc") == b"\x00\x00\x00\x00\x03abc"


def test_metadata_carries_key_version_and_session(credentials, monkeypatch):
    import integrations.windsurf_proxy.discovery as discovery

    monkeypatch.setattr(
        discovery,
        "get_metadata_fields",
        lambda: dict(discovery.DEFAULT_METADATA_FIELDS),
    )
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    fields = _parse_fields(g._build_metadata(credentials, session_id="sess-1"))

    assert _get_field(fields, 1, 2) == b"sk-test-0000"
    assert _get_field(fields, 2, 2) == b"windsurf"
    assert _get_field(fields, 3, 2) == b"1.13.200"
    assert _get_field(fields, 4, 2) == b"1.13.200"
    assert _get_all_fields(fields, 5, 2) == [b"sess-1", b"macos"]
    assert _get_field(fields, 6, 2) == b"en"
    assert _get_field(fields, 9, 0) == 1
    assert _get_field(fields, 12, 2) == b"codeium.windsurf"
    assert _get_field(fields, 26, 2) == b"Pro"


def test_metadata_follows_discovered_field_numbers(credentials, monkeypatch):
    import integrations.windsurf_proxy.discovery as discovery

    discovered = {
        "api_key": 3,
        "ide_name": 1,
        "ide_version": 7,
        "extension_version": 2,
        "session_id": 10,
        "locale": 4,
        "os": 5,
    }
    monkeypatch.setattr(discovery, "get_metadata_fields", lambda: discovered)
    fields = _parse_fields(g._build_metadata(credentials))

    assert _get_field(fields, 3, 2) == b"sk-test-0000"
    assert _get_field(fields, 1, 2) == b"windsurf"
    # "os" is a discovered field: the hard-coded os entry is not added.
    assert _get_all_fields(fields, 5, 2) == []
    assert len(_get_field(fields, 10, 2)) == 36  # a fresh UUID


@pytest.mark.parametrize(
    ("role", "source"),
    [("user", 1), ("SYSTEM", 2), ("assistant", 3), ("tool", 1)],
)
def test_chat_message_nests_the_text_three_levels_deep(role, source):
    fields = _parse_fields(g._build_chat_message(role, "Bonjour", "conv-1"))
    assert _get_field(fields, 2, 0) == source
    assert _get_field(fields, 4, 2) == b"conv-1"
    intent = _parse_fields(_get_field(fields, 5, 2))
    generic = _parse_fields(_get_field(intent, 1, 2))
    assert _get_field(generic, 1, 2) == b"Bonjour"


def test_chat_request_with_every_optional_field(credentials):
    request = g._build_chat_request(
        credentials,
        [{"role": "system", "content": "be brief"}, {"content": "hi"}],
        model_enum=281,
        model_name="MODEL_CLAUDE_4_SONNET",
        system_prompt="override",
    )
    fields = _parse_fields(request)
    messages = _get_all_fields(fields, 2, 2)
    assert len(messages) == 2
    # Both messages share one conversation id.
    conv = {_get_field(_parse_fields(m), 4, 2) for m in messages}
    assert len(conv) == 1
    assert _get_field(_parse_fields(messages[1]), 2, 0) == g.SOURCE_USER
    assert _get_field(fields, 3, 2) == b"override"
    assert _get_field(fields, 4, 0) == 281
    assert _get_field(fields, 5, 2) == b"MODEL_CLAUDE_4_SONNET"


def test_chat_request_leaves_out_empty_optionals(credentials):
    fields = _parse_fields(g._build_chat_request(credentials, [], 0, ""))
    assert _get_field(fields, 3, 2) is None
    assert _get_field(fields, 5, 2) is None
    assert _get_field(fields, 4, 0) == 0


# --------------------------------------------------------------------------
# Response parsing
# --------------------------------------------------------------------------


def test_text_is_read_from_delta_message_field_five():
    payload = _text_frame("Hello")[5:]
    assert g._extract_text_from_response(payload) == "Hello"


def test_fixed_width_and_other_fields_are_skipped():
    raw_chat = (
        g._encode_tag(8, 5)
        + b"\x00\x00\x00\x00"  # fixed32
        + g._encode_tag(9, 1)
        + b"\x00" * 8  # fixed64
        + g._encode_string_field(4, "conv")
        + g._encode_string_field(5, "kept")
    )
    payload = (
        g._encode_varint_field(3, 7)
        + g._encode_tag(6, 5)
        + b"\x00\x00\x00\x00"
        + g._encode_tag(7, 1)
        + b"\x00" * 8
        + g._encode_bytes_field(2, b"tool call")
        + g._encode_bytes_field(1, raw_chat)
    )
    assert g._extract_text_from_response(payload) == "kept"


def test_unknown_wire_type_stops_parsing():
    # Wire type 3 (deprecated group start) ends both readers.
    assert g._extract_text_from_response(g._encode_tag(1, 3) + b"rest") == ""
    raw_chat = g._encode_tag(2, 3) + g._encode_string_field(5, "after")
    assert g._extract_text_from_raw_chat_message(raw_chat) == ""


def test_text_that_is_not_utf8_is_skipped():
    raw_chat = g._encode_bytes_field(5, b"\xff\xfe") + g._encode_varint_field(6, 1)
    assert g._extract_text_from_raw_chat_message(raw_chat) == ""


@pytest.mark.parametrize(
    ("trailer", "expected"),
    [
        (
            json.dumps({"error": {"code": "unavailable", "message": "down"}}).encode(),
            "unavailable: down",
        ),
        (json.dumps({"error": {"details": []}}).encode(), "unknown: unknown error"),
        (json.dumps({}).encode(), None),
        (b"{not json", None),
    ],
)
def test_trailer_errors(trailer, expected):
    assert g._check_connect_trailer(trailer) == expected


def test_panel_lock_is_created_once():
    async def two_locks():
        return g._get_panel_init_lock(), g._get_panel_init_lock()

    first, second = asyncio.run(two_locks())
    assert first is second


# --------------------------------------------------------------------------
# Panel initialization
# --------------------------------------------------------------------------


async def test_panel_initialized_once(connect_server, credentials):
    connect_server.reply(g.INIT_PANEL_PATH, Reply(status=200))

    await asyncio.gather(
        g._ensure_panel_initialized(credentials),
        g._ensure_panel_initialized(credentials),
    )
    await g._ensure_panel_initialized(credentials)

    assert g._panel_initialized is True
    requests = [r for r in connect_server.requests if r.path == g.INIT_PANEL_PATH]
    assert len(requests) == 1
    assert requests[0].headers["x-codeium-csrf-token"] == "c5rf-test-0000"
    assert requests[0].headers["content-type"] == "application/proto"
    fields = _parse_fields(requests[0].body)
    assert _get_field(fields, 3, 0) == 1
    assert _get_field(_parse_fields(_get_field(fields, 1, 2)), 1, 2) == b"sk-test-0000"


async def test_panel_refused_is_a_stream_error(connect_server, credentials):
    connect_server.reply(g.INIT_PANEL_PATH, Reply(status=403, body=b"csrf mismatch"))
    with pytest.raises(WindsurfError, match="status=403.*csrf mismatch") as caught:
        await g._ensure_panel_initialized(credentials)
    assert caught.value.code is WindsurfErrorCode.STREAM_ERROR
    assert g._panel_initialized is False


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_panel_unreachable_is_a_connection_failure(credentials):
    credentials.port = _closed_port()
    with pytest.raises(
        WindsurfError, match="InitializeCascadePanelState error"
    ) as caught:
        await g._ensure_panel_initialized(credentials)
    assert caught.value.code is WindsurfErrorCode.CONNECTION_FAILED


async def test_panel_without_httpx_says_how_to_install(monkeypatch, credentials):
    _block_httpx_import(monkeypatch)
    with pytest.raises(ImportError, match=r"httpx\[http2\]"):
        await g._ensure_panel_initialized(credentials)


# --------------------------------------------------------------------------
# Streaming chat
# --------------------------------------------------------------------------


async def _collect(credentials, **kwargs) -> list[str]:
    params = {
        "messages": [{"role": "user", "content": "ping"}],
        "model_enum": 281,
        "model_name": "MODEL_CLAUDE_4_SONNET",
    }
    params.update(kwargs)
    return [chunk async for chunk in g.stream_chat(credentials, **params)]


async def test_stream_yields_each_text_frame_across_split_chunks(
    connect_server, credentials
):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    body = _text_frame("Hel") + _text_frame("") + _text_frame("lo") + _trailer()
    # Split inside the frame header and inside a payload.
    connect_server.reply(
        g.GRPC_SERVICE_PATH, Reply(pieces=[body[:3], body[3:12], body[12:]])
    )

    chunks = await _collect(credentials, system_prompt="sys")

    assert chunks == ["Hel", "lo"]
    request = next(r for r in connect_server.requests if r.path == g.GRPC_SERVICE_PATH)
    assert request.headers["content-type"] == "application/connect+proto"
    assert request.headers["user-agent"] == "workpilot-windsurf-proxy/1.0"
    flags, length = struct.unpack(">BI", request.body[:5])
    assert (flags, length) == (0, len(request.body) - 5)
    sent = _parse_fields(request.body[5:])
    assert _get_field(sent, 3, 2) == b"sys"


async def test_error_looking_text_is_logged_with_its_raw_frame(
    connect_server, credentials, caplog
):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    connect_server.reply(
        g.GRPC_SERVICE_PATH,
        Reply(body=_text_frame("Please update your editor") + _trailer()),
    )
    caplog.set_level("WARNING", logger=g.logger.name)

    assert await _collect(credentials) == ["Please update your editor"]
    assert "Server returned error in data frame" in caplog.text


async def test_expired_session_trailer_resets_the_panel(connect_server, credentials):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    connect_server.reply(
        g.GRPC_SERVICE_PATH,
        Reply(
            body=_text_frame("partial")
            + _trailer(
                {"code": "failed_precondition", "message": "Cascade session error"}
            )
        ),
    )

    with pytest.raises(WindsurfError, match="failed_precondition") as caught:
        await _collect(credentials)

    assert caught.value.code is WindsurfErrorCode.STREAM_ERROR
    assert g._panel_initialized is False


async def test_other_trailer_errors_keep_the_panel(connect_server, credentials):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    connect_server.reply(
        g.GRPC_SERVICE_PATH,
        Reply(body=_trailer({"code": "resource_exhausted", "message": "quota"})),
    )
    with pytest.raises(WindsurfError, match="resource_exhausted: quota"):
        await _collect(credentials)
    assert g._panel_initialized is True


async def test_http_error_status_reports_the_body(connect_server, credentials):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    connect_server.reply(
        g.GRPC_SERVICE_PATH, Reply(status=500, pieces=[b"internal ", b"boom"])
    )
    with pytest.raises(WindsurfError, match="status 500: internal boom") as caught:
        await _collect(credentials)
    assert caught.value.code is WindsurfErrorCode.CONNECTION_FAILED


async def test_connection_refused_on_the_chat_call(
    connect_server, credentials, monkeypatch
):
    # The panel is ready; only the chat call meets a closed port.
    monkeypatch.setattr(g, "_panel_initialized", True)
    credentials.port = _closed_port()
    with pytest.raises(WindsurfError, match="Failed to connect") as caught:
        await _collect(credentials)
    assert caught.value.code is WindsurfErrorCode.CONNECTION_FAILED


async def test_slow_server_times_out(connect_server, credentials, monkeypatch):
    connect_server.reply(g.INIT_PANEL_PATH, Reply())
    connect_server.reply(g.GRPC_SERVICE_PATH, Reply(body=_trailer(), delay=1.0))
    monkeypatch.setattr(g, "CHAT_TIMEOUT", 0.2)
    with pytest.raises(WindsurfError, match="timed out") as caught:
        await _collect(credentials)
    assert caught.value.code is WindsurfErrorCode.STREAM_ERROR


async def test_stream_without_httpx_says_how_to_install(monkeypatch, credentials):
    _block_httpx_import(monkeypatch)
    with pytest.raises(ImportError, match=r"httpx\[http2\]"):
        await _collect(credentials)
