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


def test_embedding_client_is_rejected_before_network():
    import pytest
    from core.agent_client import LocalAgentClient

    with pytest.raises(ValueError, match="embedding model"):
        LocalAgentClient(model="qwen3-embedding:8b")


def test_embedding_name_never_inherits_qwen_tool_support(monkeypatch):
    import urllib.request

    from ollama_model_detector import model_meta

    def offline(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", offline)
    assert (
        model_meta("http://localhost:11434", "qwen3-embedding:8b")["supports_tools"]
        is False
    )
