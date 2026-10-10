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
    (spec_dir / "context.json").write_text(
        '{"task_description":"namespace"}', encoding="utf-8"
    )
    (tmp_path / "context.json").write_text("wrong project file", encoding="utf-8")
    # A Python project, so the command allowlist the executor applies (as the
    # SDK's `bash_security_hook` does) lets `python` run.
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = 'x'\n", encoding="utf-8"
    )
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
        assert (spec_dir / "spec.md").read_text(encoding="utf-8") == "## Overview"
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
    assert (tmp_path / "context.json").read_text(
        encoding="utf-8"
    ) == "wrong project file"


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


# --- Which config each spec prompt runs under (audit F4) -------------------

import re  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent / "apps" / "backend"


def _prompts_the_pipeline_runs() -> list[str]:
    """Every prompt file the spec pipeline hands to `AgentRunner.run_agent`.

    Read from the call sites, so a prompt added next month is checked without
    anyone remembering to list it here.
    """
    sources = [
        *(BACKEND / "spec" / "phases").glob("*.py"),
        BACKEND / "spec" / "complexity.py",
    ]
    found: set[str] = set()
    for source in sources:
        text = source.read_text(encoding="utf-8")
        found |= set(re.findall(r"run_agent_fn\(\s*\"(\w+\.md)\"", text))
    return sorted(found)


def test_the_call_sites_are_found():
    """The guard below is worth nothing if the regex finds no prompt."""
    assert {"spec_researcher.md", "spec_critic.md", "planner.md"} <= set(
        _prompts_the_pipeline_runs()
    )


@pytest.mark.parametrize("prompt_file", _prompts_the_pipeline_runs())
def test_each_prompt_runs_with_the_tools_it_uses(prompt_file: str):
    """A prompt that writes its output under a config that cannot write does
    not fail: `create_minimal_research` / `create_minimal_critique` stand in
    for the file and the phase reports success over nothing. A prompt that
    asks Context7 under a config without it validates from memory."""
    from agents.tools_pkg.models import AGENT_CONFIGS
    from core.client import READ_ONLY_AGENT_TYPES
    from spec.pipeline.agent_runner import agent_type_for

    agent_type = agent_type_for(prompt_file)
    config = AGENT_CONFIGS[agent_type]
    tools = set(config["tools"])
    text = (BACKEND / "prompts" / prompt_file).read_text(encoding="utf-8")

    assert agent_type not in READ_ONLY_AGENT_TYPES, (
        f"{prompt_file} writes files and runs under read-only {agent_type!r}"
    )
    if re.search(r"cat >|<< ?'EOF'|sed -i", text):
        assert "Bash" in tools, f"{prompt_file} writes with the shell"
    if re.search(r"Write` tool|Write tool", text):
        assert "Write" in tools, f"{prompt_file} asks for the Write tool"
    if "mcp__context7__" in text:
        assert "context7" in config["mcp_servers"], f"{prompt_file} asks Context7"
    if re.search(r"\bWeb(Search|Fetch)\b", text):
        assert {"WebSearch", "WebFetch"} <= tools, f"{prompt_file} searches the web"


def test_the_researcher_and_the_self_critique_get_their_own_config():
    from spec.pipeline.agent_runner import agent_type_for

    assert agent_type_for("spec_researcher.md") == "spec_researcher"
    assert agent_type_for("spec_critic.md") == "spec_self_critique"
    # The rest write files and ask for the `Write` tool that non-Claude
    # providers only expose under `planner` / `spec_writer`.
    for prompt_file in ("spec_writer.md", "planner.md", "spec_quick.md"):
        assert agent_type_for(prompt_file) == "spec_writer"


@pytest.mark.parametrize(
    ("prompt_file", "agent_type"),
    [("spec_researcher.md", "spec_researcher"), ("spec_writer.md", "spec_writer")],
)
def test_a_non_claude_provider_gets_the_prompts_agent_type(
    tmp_path, monkeypatch, prompt_file, agent_type
):
    import core.client
    from spec.pipeline.agent_runner import AgentRunner

    factory = Mock(
        return_value=Mock(model="m", provider_name=Mock(return_value="ollama"))
    )
    monkeypatch.setattr(core.client, "_get_active_provider", lambda *_: "ollama")
    monkeypatch.setattr(core.client, "create_agent_client", factory)
    runner = AgentRunner(tmp_path, tmp_path, "m")
    runner._run_with_agent_client = AsyncMock(return_value=(True, "done"))
    asyncio.run(runner.run_agent(prompt_file))
    assert factory.call_args.kwargs["agent_type"] == agent_type


def test_claude_gets_the_prompts_agent_type(tmp_path, monkeypatch):
    import core.client
    from spec.pipeline.agent_runner import AgentRunner

    class Stop(Exception):
        pass

    class Client:
        async def __aenter__(self):
            raise Stop("captured")

        async def __aexit__(self, *args):
            return False

    factory = Mock(return_value=Client())
    monkeypatch.setattr(core.client, "_get_active_provider", lambda *_: "claude")
    monkeypatch.setattr(core.client, "create_client", factory)
    runner = AgentRunner(tmp_path, tmp_path, "claude-sonnet")
    success, _ = asyncio.run(runner.run_agent("spec_critic.md"))
    assert success is False
    assert factory.call_args.kwargs["agent_type"] == "spec_self_critique"
