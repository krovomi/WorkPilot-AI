"""Local reasoning must count as activity without leaking into the answer."""

from core.agent_client import _merge_native_chunk


def test_reasoning_chunk_is_activity():
    acc = {}
    assert _merge_native_chunk(acc, {"message": {"thinking": "reasoning"}}) > 0
    assert acc.get("tokens", 0) > 0
    assert not acc.get("content")


def test_tool_chunk_is_activity():
    acc = {}
    calls = [{"function": {"name": "Read", "arguments": {"path": "a"}}}]
    assert _merge_native_chunk(acc, {"message": {"tool_calls": calls}}) > 0
    assert acc["tool_calls"] == calls
