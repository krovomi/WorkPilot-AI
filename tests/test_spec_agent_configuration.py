"""Spec execution must attribute logs to the same LLM used by the factory."""

import asyncio
from unittest.mock import AsyncMock, Mock


def test_spec_logs_and_factory_use_the_same_configuration(tmp_path, monkeypatch):
    import core.client
    from spec.pipeline.agent_runner import AgentRunner

    factory = Mock(
        return_value=Mock(
            model="qwen2.5-coder:7b", provider_name=Mock(return_value="ollama")
        )
    )
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
    assert logger.mock_calls[0].args == ("ollama", "qwen2.5-coder:7b")
    assert logger.mock_calls[0][0] == "set_llm"


def test_local_runtime_error_cannot_be_reported_as_spec_success(tmp_path):
    import pytest
    from core.agent_client import (
        AgentMessage,
        ContentBlock,
        ContentBlockType,
        LocalModelRuntimeError,
        MessageRole,
    )
    from spec.pipeline.agent_runner import AgentRunner

    class FailedClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def provider_name(self):
            return "ollama"

        async def query(self, prompt):
            pass

        async def receive_response(self):
            yield AgentMessage(
                role=MessageRole.SYSTEM,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text="Progress heartbeat that is long enough to pass the former empty-session check.",
                    )
                ],
            )
            raise LocalModelRuntimeError("generation stalled")

    runner = AgentRunner(tmp_path, tmp_path, "qwen3-coder:30b", Mock())
    with pytest.raises(LocalModelRuntimeError, match="generation stalled"):
        asyncio.run(runner._run_with_agent_client(FailedClient(), "namespace"))


def test_validation_tools_use_spec_directory_and_preserve_project_boundary(tmp_path):
    import pytest
    from core.agent_client import LocalAgentClient
    from spec.pipeline.agent_runner import AgentRunner

    spec_dir = tmp_path / ".workpilot" / "specs" / "002-namespace"
    spec_dir.mkdir(parents=True)
    (spec_dir / "context.json").write_text('{"task_description":"namespace"}')
    (tmp_path / "context.json").write_text("wrong project file")
    client = LocalAgentClient(
        model="qwen2.5-coder:7b", project_dir=str(tmp_path), offline_only=True
    )
    runner = AgentRunner(tmp_path, spec_dir, "qwen3-coder:30b")

    async def query(prompt):
        executor = client._tool_executor
        assert (
            await executor.execute("read_file", {"path": "./context.json"})
            == '{"task_description":"namespace"}'
        )
        await executor.execute(
            "write_file", {"path": "spec.md", "content": "## Overview"}
        )
        assert (spec_dir / "spec.md").read_text() == "## Overview"
        assert not (tmp_path / "spec.md").exists()
        import sys

        command = f'"{sys.executable}" -c "import os; print(os.getcwd())"'
        assert str(spec_dir) in await executor.execute(
            "run_command", {"command": command}
        )
        with pytest.raises(ValueError, match="outside"):
            await executor.execute(
                "read_file", {"path": str(tmp_path.parent / "secret.txt")}
            )
        with pytest.raises(FileNotFoundError):
            await executor.execute("read_file", {"path": "missing.json"})

    async def responses():
        from core.agent_client import (
            AgentMessage,
            ContentBlock,
            ContentBlockType,
            MessageRole,
        )

        yield AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(
                    type=ContentBlockType.TEXT,
                    text="Validation files were read and repaired in the task specification directory.",
                )
            ],
        )

    client.query = query
    client.receive_response = responses
    assert asyncio.run(
        runner._run_with_agent_client(client, "fix", working_directory=spec_dir)
    )[0]
    assert (tmp_path / "context.json").read_text() == "wrong project file"


def test_validation_launch_configures_local_working_directory(tmp_path, monkeypatch):
    import core.client
    from core.agent_client import LocalAgentClient
    from spec.pipeline.agent_runner import AgentRunner

    spec_dir = tmp_path / "specs" / "002"
    spec_dir.mkdir(parents=True)
    client = LocalAgentClient(
        model="qwen2.5-coder:7b", project_dir=str(tmp_path), offline_only=True
    )
    monkeypatch.setattr(core.client, "_get_active_provider", lambda *_: "ollama")
    monkeypatch.setattr(core.client, "create_agent_client", lambda **_: client)
    runner = AgentRunner(tmp_path, spec_dir, "qwen3-coder:30b")
    runner._run_with_agent_client = AsyncMock(return_value=(True, "fixed"))
    asyncio.run(runner.run_agent("validation_fixer.md"))
    assert (
        runner._run_with_agent_client.call_args.kwargs["working_directory"] == spec_dir
    )
    assert "Tool working directory:" in runner._run_with_agent_client.call_args.args[1]
    asyncio.run(runner.run_agent("spec_writer.md"))
    assert runner._run_with_agent_client.call_args.kwargs["working_directory"] is None
