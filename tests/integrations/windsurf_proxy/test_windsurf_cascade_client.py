"""The Cascade flow (`windsurf_proxy/cascade_client.py`).

A full turn runs against the local language-server stand-in: StartCascade,
SendUserCascadeMessage, then the trajectory and status polls the server
scripts step by step. Poll timings are shrunk so a turn takes milliseconds.
"""

from __future__ import annotations

import builtins
import json

import pytest
from integrations.windsurf_proxy import cascade_client as c
from integrations.windsurf_proxy import grpc_client as g
from integrations.windsurf_proxy.auth import WindsurfError, WindsurfErrorCode

from tests.integrations.windsurf_proxy.connect_fake import Reply

enc_s = g._encode_string_field
enc_b = g._encode_bytes_field
enc_v = g._encode_varint_field


def _step(
    step_type: int = c.STEP_PLANNER_RESPONSE,
    response: str | None = None,
    modified: str | None = None,
    thinking: str | None = None,
    error_message: bytes | None = None,
    error: bytes | None = None,
) -> bytes:
    parts = enc_v(1, step_type) + enc_v(4, 3)
    planner = b""
    if response is not None:
        planner += enc_s(1, response)
    if thinking is not None:
        planner += enc_s(3, thinking)
    if modified is not None:
        planner += enc_s(8, modified)
    if planner:
        parts += enc_b(20, planner)
    if error_message is not None:
        parts += enc_b(24, error_message)
    if error is not None:
        parts += enc_b(31, error)
    return parts


def _steps(*steps: bytes) -> Reply:
    return Reply(body=b"".join(enc_b(1, s) for s in steps))


def _status(value: int) -> Reply:
    return Reply(body=enc_s(1, "cascade-1") + enc_v(2, value))


RUNNING = 2


@pytest.fixture
def fast_polls(monkeypatch):
    monkeypatch.setattr(c, "_POLL_INTERVAL", 0.0)
    monkeypatch.setattr(c, "_IDLE_GRACE", 0.0)


def _script_turn(
    server, steps: list[Reply], statuses: list[Reply], cascade_id="cascade-1"
):
    server.reply(g.INIT_PANEL_PATH, Reply())
    server.reply(c.START_CASCADE_PATH, Reply(body=enc_s(1, cascade_id)))
    server.reply(c.SEND_CASCADE_PATH, Reply())
    server.reply(c.GET_STEPS_PATH, *steps)
    server.reply(c.GET_STATUS_PATH, *statuses)


MESSAGES = [
    {"role": "system", "content": "You are terse."},
    {"role": "user", "content": "ping"},
]


# --------------------------------------------------------------------------
# Builders and parsers
# --------------------------------------------------------------------------


def test_cascade_config_with_both_model_routes():
    config = c._parse_fields(c._build_cascade_config(281, "MODEL_CLAUDE_4_SONNET"))
    planner = c._parse_fields(c._get_field(config, 1, 2))
    conversational = c._parse_fields(c._get_field(planner, 2, 2))
    assert c._get_field(conversational, 4, 0) == c.PLANNER_MODE_NO_TOOL
    assert c._get_field(planner, 35, 2) == b"MODEL_CLAUDE_4_SONNET"
    assert c._get_field(planner, 34, 2) == b"MODEL_CLAUDE_4_SONNET"
    assert c._get_field(c._parse_fields(c._get_field(planner, 15, 2)), 1, 0) == 281
    assert c._get_field(planner, 1, 0) == 281
    brain = c._parse_fields(c._get_field(config, 7, 2))
    assert c._get_field(brain, 1, 0) == 1


def test_cascade_config_by_uid_only():
    planner = c._parse_fields(
        c._get_field(c._parse_fields(c._build_cascade_config(0, "swe-1-6")), 1, 2)
    )
    assert c._get_field(planner, 35, 2) == b"swe-1-6"
    assert c._get_field(planner, 15, 2) is None


def test_cascade_config_by_enum_only():
    planner = c._parse_fields(
        c._get_field(c._parse_fields(c._build_cascade_config(359, "")), 1, 2)
    )
    assert c._get_field(planner, 35, 2) is None
    assert c._get_field(planner, 1, 0) == 359


def test_cascade_config_needs_a_model():
    with pytest.raises(ValueError, match="model_uid or model_enum"):
        c._build_cascade_config(0, "")


def test_steps_request_offset_only_when_positive():
    assert (
        c._get_field(c._parse_fields(c._build_get_steps_request("id", 0)), 2, 0) is None
    )
    fields = c._parse_fields(c._build_get_steps_request("id", 5))
    assert c._get_field(fields, 1, 2) == b"id"
    assert c._get_field(fields, 2, 0) == 5
    assert c._build_get_status_request("id") == enc_s(1, "id")


def test_fields_reader_skips_fixed_width_and_stops_on_unknown():
    data = (
        g._encode_tag(1, 5)
        + b"\x00" * 4
        + g._encode_tag(2, 1)
        + b"\x00" * 8
        + enc_v(3, 9)
        + g._encode_tag(4, 3)
        + enc_v(5, 1)
    )
    assert c._parse_fields(data) == [(3, 0, 9)]


def test_empty_responses_parse_to_nothing():
    assert c._parse_start_cascade_response(b"") == ""
    assert c._parse_status_response(b"") == 0
    assert c._parse_trajectory_steps(b"") == []


def test_trajectory_step_texts_and_errors():
    details = enc_s(1, "") + enc_s(2, "  quota exceeded  \nsecond line")
    steps = c._parse_trajectory_steps(
        b"".join(
            enc_b(1, s)
            for s in (
                _step(response="draft", modified="final", thinking="hmm"),
                _step(response="only response"),
                _step(c.STEP_ERROR_MESSAGE, error_message=enc_b(3, details)),
                _step(c.STEP_ERROR_MESSAGE, error=enc_s(3, "full error")),
                _step(
                    c.STEP_ERROR_MESSAGE,
                    error_message=enc_s(1, "no details"),
                    error=enc_s(1, " "),
                ),
                enc_b(20, enc_s(1, "x")),  # no type or status
            )
        )
    )
    assert steps[0]["text"] == "final"
    assert steps[0]["response_text"] == "draft"
    assert steps[0]["thinking"] == "hmm"
    assert steps[0]["status"] == 3
    assert steps[1]["text"] == "only response"
    assert steps[2]["error_text"] == "quota exceeded"
    assert steps[3]["error_text"] == "full error"
    assert steps[4]["error_text"] == ""
    assert (steps[5]["type"], steps[5]["status"]) == (0, 0)


@pytest.mark.parametrize(
    ("messages", "expected"),
    [
        ([], ""),
        ([{"role": "user", "content": "hi"}], "hi"),
        ([{"role": "system", "content": ""}, {"role": "user", "content": 42}], "42"),
        (
            [
                {"role": "system", "content": "sys"},
                {"content": "first"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "second"},
            ],
            "sys\n\n[Conversation so far]\nUser: first\n\nAssistant: answer"
            "\n\n[Current user message]\nsecond",
        ),
    ],
)
def test_conversation_is_flattened_with_the_latest_turn_apart(messages, expected):
    assert c._flatten_messages(messages) == expected


# --------------------------------------------------------------------------
# Unary transport
# --------------------------------------------------------------------------


async def test_unary_call_returns_the_raw_body(connect_server, credentials):
    connect_server.reply(c.START_CASCADE_PATH, Reply(body=b"\x0a\x01x"))
    body = await c._unary_call(credentials, c.START_CASCADE_PATH, b"payload")
    assert body == b"\x0a\x01x"
    request = connect_server.requests[-1]
    assert request.body == b"payload"
    assert request.headers["x-codeium-csrf-token"] == "c5rf-test-0000"
    assert request.headers["connect-protocol-version"] == "1"


async def test_unary_call_http_error(connect_server, credentials):
    connect_server.reply(c.START_CASCADE_PATH, Reply(status=503, body=b"busy"))
    with pytest.raises(
        WindsurfError, match=r"StartCascade failed \(status=503\): busy"
    ) as caught:
        await c._unary_call(credentials, c.START_CASCADE_PATH, b"")
    assert caught.value.code is WindsurfErrorCode.STREAM_ERROR


async def test_unary_call_json_error_body(connect_server, credentials):
    body = json.dumps({"code": "permission_denied", "message": "no plan"}).encode()
    connect_server.reply(
        c.START_CASCADE_PATH, Reply(body=body, content_type="application/json")
    )
    with pytest.raises(WindsurfError, match="permission_denied: no plan"):
        await c._unary_call(credentials, c.START_CASCADE_PATH, b"")


async def test_unary_call_json_that_does_not_parse_is_returned(
    connect_server, credentials
):
    connect_server.reply(
        c.START_CASCADE_PATH, Reply(body=b"{oops", content_type="application/json")
    )
    assert await c._unary_call(credentials, c.START_CASCADE_PATH, b"") == b"{oops"


async def test_unary_call_without_httpx(monkeypatch, credentials):
    real_import = builtins.__import__

    def fake(name, *args, **kwargs):
        if name == "httpx":
            raise ImportError("no httpx")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake)
    with pytest.raises(ImportError, match="Cascade client"):
        await c._unary_call(credentials, c.START_CASCADE_PATH, b"")


# --------------------------------------------------------------------------
# A whole turn
# --------------------------------------------------------------------------


async def test_turn_streams_growing_text_then_tops_up_from_the_final_sweep(
    connect_server, credentials, fast_polls
):
    _script_turn(
        connect_server,
        steps=[
            _steps(_step(response="Hel")),
            _steps(_step(response="Hello"), _step(response="")),
            _steps(_step(response="Hello")),
            _steps(_step(response="Hello")),
            # Final sweep: a longer response and a modified response extending it.
            _steps(_step(response="Hello!", modified="Hello! World")),
        ],
        statuses=[_status(RUNNING), _status(RUNNING), _status(c.STATUS_IDLE)],
    )

    text = await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_CLAUDE_4_SONNET")

    assert text == "Hello! World"
    sends = connect_server.bodies(c.SEND_CASCADE_PATH)
    fields = c._parse_fields(sends[0])
    assert c._get_field(fields, 1, 2) == b"cascade-1"
    sent_text = c._get_field(c._parse_fields(c._get_field(fields, 2, 2)), 1, 2)
    assert sent_text == b"You are terse.\n\nping"
    # The start call and the send share one session id.
    start_meta = c._parse_fields(
        c._get_field(
            c._parse_fields(connect_server.bodies(c.START_CASCADE_PATH)[0]), 1, 2
        )
    )
    send_meta = c._parse_fields(c._get_field(fields, 3, 2))
    assert c._get_field(start_meta, 5, 2) == c._get_field(send_meta, 5, 2)


async def test_modified_text_that_rewrites_the_response_is_not_appended(
    connect_server, credentials, fast_polls
):
    _script_turn(
        connect_server,
        steps=[
            _steps(_step(response="abc")),
            _steps(_step(response="abc", modified="xyz-longer")),
        ],
        statuses=[_status(c.STATUS_IDLE)],
    )
    assert await c.cascade_chat(credentials, MESSAGES, 0, "swe-1-6") == "abc"


async def test_empty_cascade_id_is_an_error(connect_server, credentials, fast_polls):
    _script_turn(connect_server, steps=[_steps()], statuses=[_status(1)], cascade_id="")
    with pytest.raises(WindsurfError, match="empty cascade_id"):
        await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X")
    assert connect_server.bodies(c.SEND_CASCADE_PATH) == []


async def test_an_error_step_aborts_the_turn(connect_server, credentials, fast_polls):
    _script_turn(
        connect_server,
        steps=[
            _steps(_step(c.STEP_ERROR_MESSAGE, error=enc_s(1, "model unavailable")))
        ],
        statuses=[_status(RUNNING)],
    )
    with pytest.raises(WindsurfError, match="model unavailable") as caught:
        await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X")
    assert caught.value.code is WindsurfErrorCode.STREAM_ERROR


async def test_max_wait_returns_what_arrived(
    connect_server, credentials, fast_polls, monkeypatch
):
    monkeypatch.setattr(c, "_MAX_WAIT", -1.0)
    _script_turn(connect_server, steps=[_steps()], statuses=[_status(RUNNING)])
    assert await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X") == ""
    assert connect_server.bodies(c.GET_STEPS_PATH) == []


async def test_warm_stall_accepts_the_partial_text(
    connect_server, credentials, fast_polls, monkeypatch
):
    monkeypatch.setattr(c, "_NO_GROWTH_STALL", 0.0)
    _script_turn(
        connect_server,
        steps=[_steps(_step(response="partial"))],
        statuses=[_status(RUNNING)],
    )
    assert await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X") == "partial"


async def test_early_idle_is_ignored_during_the_grace_window(
    connect_server, credentials, fast_polls, monkeypatch
):
    monkeypatch.setattr(c, "_IDLE_GRACE", 60.0)
    idle = _status(c.STATUS_IDLE)
    _script_turn(
        connect_server,
        steps=[_steps()],
        statuses=[idle, idle, idle, idle, idle, _status(RUNNING), idle],
    )

    assert await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X") == ""
    # The five idle polls before the cascade ever ran do not count: once it
    # ran, four idle polls end the turn. Counted in polls, not in seconds.
    assert len(connect_server.bodies(c.GET_STATUS_PATH)) == 10


async def test_idle_without_text_needs_four_polls(
    connect_server, credentials, fast_polls
):
    _script_turn(
        connect_server,
        steps=[_steps()],
        statuses=[_status(c.STATUS_IDLE), _status(RUNNING), _status(c.STATUS_IDLE)],
    )
    assert await c.cascade_chat(credentials, MESSAGES, 281, "MODEL_X") == ""
    # 1 idle (reset by RUNNING), then 4 idle polls: 6 status calls.
    assert len(connect_server.bodies(c.GET_STATUS_PATH)) == 6
