"""The suite refuses to start the Claude Code CLI (`tests/conftest.py`)."""

import pytest
from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport


async def test_the_sdk_transport_refuses_to_connect_inside_the_suite(
    _no_live_claude_cli,
):
    transport = object.__new__(SubprocessCLITransport)

    with pytest.raises(RuntimeError, match="WORKPILOT_RUN_LIVE_API_TESTS"):
        await transport.connect()

    # The refusal is recorded so a test that swallows it still fails at
    # teardown. This one expected it: clear the record.
    assert len(_no_live_claude_cli) == 1
    _no_live_claude_cli.clear()
