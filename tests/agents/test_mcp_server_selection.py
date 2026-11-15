"""Which MCP servers an agent starts, after the project's own toggles."""

from __future__ import annotations

from pathlib import Path

import pytest
from agents.tools_pkg.models import get_required_mcp_servers


@pytest.fixture(autouse=True)
def no_brain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # An empty folder is no brain: the shared brain is not offered.
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "no-brain"))


def test_context7_turned_off_for_the_project_is_not_started() -> None:
    servers = get_required_mcp_servers(
        "planner", mcp_config={"CONTEXT7_ENABLED": "False"}
    )

    assert "context7" not in servers
    assert "workpilot" in servers


def test_a_custom_server_can_be_added_and_removed_by_its_id() -> None:
    custom = [{"id": "acme-docs"}, {"name": "no id"}]

    added = get_required_mcp_servers(
        "planner",
        mcp_config={
            "CUSTOM_MCP_SERVERS": custom,
            "AGENT_MCP_planner_ADD": "acme-docs, nobody-knows,",
        },
    )
    removed = get_required_mcp_servers(
        "planner",
        mcp_config={
            "CUSTOM_MCP_SERVERS": custom,
            "AGENT_MCP_planner_ADD": "acme-docs",
            "AGENT_MCP_planner_REMOVE": "acme-docs,workpilot,unknown",
        },
    )

    assert "acme-docs" in added
    # A name that is neither known nor a custom server is ignored.
    assert "nobody-knows" not in added
    assert "acme-docs" not in removed
    # The WorkPilot server is never removed.
    assert "workpilot" in removed
