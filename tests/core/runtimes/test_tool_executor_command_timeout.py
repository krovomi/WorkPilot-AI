"""`LOCAL_COMMAND_TIMEOUT` never costs an agent its tools.

The agent clients build `ToolExecutor` inside a ``try`` and fall back to
text-only mode on any error. The executor used to read the variable with a
bare ``float(...)``, so a typo (``120s``) or an empty value raised in
``__init__`` and the agent ran with no tools at all, saying so only in a
warning; ``0`` or a negative value killed every shell command at once.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from core.runtimes.tool_executor import ToolExecutor


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_unset_or_empty_uses_the_default(
    raw: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    if raw is None:
        monkeypatch.delenv("LOCAL_COMMAND_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("LOCAL_COMMAND_TIMEOUT", raw)
    with caplog.at_level(logging.WARNING):
        executor = ToolExecutor(str(tmp_path))
    assert executor.command_timeout == 120.0
    assert "LOCAL_COMMAND_TIMEOUT" not in caplog.text


@pytest.mark.parametrize("raw", ["abc", "120s", "nan", "inf", "-inf"])
def test_invalid_value_falls_back_to_the_default_with_a_warning(
    raw: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    monkeypatch.setenv("LOCAL_COMMAND_TIMEOUT", raw)
    with caplog.at_level(logging.WARNING):
        executor = ToolExecutor(str(tmp_path))
    assert executor.command_timeout == 120.0
    assert "LOCAL_COMMAND_TIMEOUT" in caplog.text


@pytest.mark.parametrize("raw", ["0", "-5", "0.2"])
def test_value_below_one_second_is_floored(
    raw: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:
    monkeypatch.setenv("LOCAL_COMMAND_TIMEOUT", raw)
    with caplog.at_level(logging.WARNING):
        executor = ToolExecutor(str(tmp_path))
    assert executor.command_timeout == 1.0
    assert "LOCAL_COMMAND_TIMEOUT" in caplog.text


@pytest.mark.parametrize(("raw", "expected"), [("1", 1.0), ("30", 30.0), ("2.5", 2.5)])
def test_valid_value_is_kept(
    raw: str, expected: float, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOCAL_COMMAND_TIMEOUT", raw)
    assert ToolExecutor(str(tmp_path)).command_timeout == expected


@pytest.mark.asyncio
async def test_invalid_value_no_longer_puts_the_client_in_text_only_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bug as a user met it: OpenAI with an API key, no tools, no error."""
    from core.agent_client import OpenAIAgentClient

    monkeypatch.setenv("LOCAL_COMMAND_TIMEOUT", "abc")
    # No MCP server: the bridge would only add noise to the tool list.
    monkeypatch.setattr(
        "core.mcp_tools.load_mcp_server_configs_for", lambda *args, **kwargs: []
    )
    client = OpenAIAgentClient(
        project_dir=str(tmp_path), agent_type="coder", api_key="sk-test-0000"
    )
    async with client:
        assert client._tool_executor is not None
        assert client._tool_executor.command_timeout == 120.0
        offered = {tool["name"] for tool in client._tool_definitions}
        assert "run_command" in offered
