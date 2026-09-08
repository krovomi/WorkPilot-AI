"""Spec execution must attribute logs to the same LLM used by the factory."""

import asyncio
from unittest.mock import AsyncMock, Mock


def test_spec_logs_and_factory_use_the_same_configuration(tmp_path, monkeypatch):
    import core.client
    from spec.pipeline.agent_runner import AgentRunner

    factory = Mock(return_value=object())
    monkeypatch.setattr(core.client, "_get_active_provider", lambda *_: "ollama")
    monkeypatch.setattr(core.client, "create_agent_client", factory)
    logger = Mock()
    runner = AgentRunner(tmp_path, tmp_path, "qwen3-coder:30b", logger)
    runner._run_with_agent_client = AsyncMock(return_value=(True, "done"))
    assert asyncio.run(runner.run_agent("spec_writer.md", thinking_budget=1024)) == (
        True,
        "done",
    )
    assert factory.call_args.kwargs["model"] == "qwen3-coder:30b"
    assert factory.call_args.kwargs["provider"] == "ollama"
    assert factory.call_args.kwargs["max_thinking_tokens"] == 1024
    assert logger.mock_calls[0].args == ("ollama", "qwen3-coder:30b")
    assert logger.mock_calls[0][0] == "set_llm"
