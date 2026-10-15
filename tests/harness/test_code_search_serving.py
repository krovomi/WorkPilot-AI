"""`search_code` reaches every provider, and only the agent types that declare it.

The Claude Agent SDK gets the ``workpilot-code`` MCP server from
`create_client`; any other MCP client can start the same server from
``runners/code_search_mcp.py``; the loops WorkPilot holds get the same tool
in-process from `ToolExecutor`. All three read one declaration: ``"code"`` in
``AGENT_CONFIGS[agent_type]["mcp_servers"]``.
"""

from __future__ import annotations

import asyncio
import importlib
import io
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from agents.tools_pkg import (
    AGENT_CONFIGS,
    get_allowed_tools,
    get_required_mcp_servers,
    mcp_tools_for_servers,
)
from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions
from harness.application import code_search
from harness.tools.code_search import (
    MCP_TOOL_NAMES,
    SERVER_KEY,
    TOOL_NAME,
    TOOLS,
    mcp_server_config,
)
from harness.tools.code_search_mcp import PAGE_CHARS, handle, page_chars, serve

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"

#: The types that explore the project's code to find where to act or what to
#: check. A type whose whole input is in its prompt (commit message, merge
#: resolution, insight extraction, the template filler…) does not get it.
CODE_SEARCH_TYPES = frozenset(
    {
        "spec_critic",
        "planner",
        "coder",
        "qa_reviewer",
        "qa_fixer",
        "verifier",
        "analyzer",
        "architecture_visualizer",
        "architecture_reviewer",
        "impact_analyzer",
        "pr_reviewer",
        "pr_orchestrator_parallel",
        "pr_followup_parallel",
        "pr_finding_validator",
        "ideation",
        "roadmap_discovery",
    }
)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    code_search.clear_indexes()
    monkeypatch.delenv("MAX_MCP_OUTPUT_TOKENS", raising=False)
    yield
    code_search.clear_indexes()


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "budget.py").write_text(
        "def over_budget(spent, cap):\n    return spent > cap\n", encoding="utf-8"
    )
    return tmp_path


# --- The declaration -------------------------------------------------------------------


def test_it_is_declared_by_the_intended_types_only():
    declaring = {t for t, c in AGENT_CONFIGS.items() if "code" in c["mcp_servers"]}
    assert declaring == CODE_SEARCH_TYPES


@pytest.mark.parametrize("agent_type", sorted(CODE_SEARCH_TYPES))
def test_every_declaring_type_already_reads_and_searches(agent_type):
    assert {"Read", "Glob", "Grep"} <= set(AGENT_CONFIGS[agent_type]["tools"])


def test_a_type_with_no_tool_never_declares_it():
    for agent_type, config in AGENT_CONFIGS.items():
        if not config["tools"]:
            assert "code" not in config["mcp_servers"], agent_type


def test_the_declaration_names_the_tool_on_the_claude_side():
    assert mcp_tools_for_servers(["code"]) == list(MCP_TOOL_NAMES)
    assert MCP_TOOL_NAMES == (f"mcp__{SERVER_KEY}__{TOOL_NAME}",)
    assert "code" in get_required_mcp_servers("coder")
    assert MCP_TOOL_NAMES[0] in get_allowed_tools("coder")
    assert MCP_TOOL_NAMES[0] not in get_allowed_tools("spec_researcher")


def test_a_project_can_take_it_away_from_a_type():
    config = {"AGENT_MCP_coder_REMOVE": "workpilot-code"}
    assert "code" not in get_required_mcp_servers("coder", mcp_config=config)
    config = {"AGENT_MCP_spec_researcher_ADD": "code"}
    assert "code" in get_required_mcp_servers("spec_researcher", mcp_config=config)


# --- The loops WorkPilot holds: ToolExecutor ---------------------------------------------


@pytest.mark.parametrize("agent_type", sorted(AGENT_CONFIGS))
def test_the_executor_offers_it_exactly_to_the_declaring_types(agent_type):
    offered = {tool["name"] for tool in get_tool_definitions(agent_type)}
    assert (TOOL_NAME in offered) == (agent_type in CODE_SEARCH_TYPES)


def test_the_executor_refuses_it_to_a_type_that_does_not_declare_it(project):
    executor = ToolExecutor(str(project), agent_type="commit_message")
    result = asyncio.run(executor.execute(TOOL_NAME, {"query": "over_budget"}))
    assert "is not available to this agent" in result
    assert "def over_budget" not in result


def test_the_executor_runs_it_under_the_clients_result_cap(project):
    (project / "app" / "long.py").write_text(
        "def long_cap():\n" + "    cap = 1\n" * 300, encoding="utf-8"
    )
    executor = ToolExecutor(str(project), agent_type="coder")
    executor.result_max_chars = 2_000
    result = asyncio.run(executor.execute(TOOL_NAME, {"query": "over_budget cap"}))
    assert "app/budget.py:1-2 · over_budget (function)" in result
    assert len(result) <= 2_000


def test_a_bad_call_is_answered_not_raised(project):
    executor = ToolExecutor(str(project), agent_type="coder")
    result = asyncio.run(executor.execute(TOOL_NAME, {"query": ""}))
    assert result.startswith("Error:")
    result = asyncio.run(
        executor.execute(TOOL_NAME, {"query": "cap", "limit": "two", "offset": "x"})
    )
    assert "over_budget" in result


# --- The loops a SDK or a CLI holds: MCP --------------------------------------------------


def _rpc(root: Path, method: str, params: dict | None = None, msg_id: int = 1):
    return handle(
        root, {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}
    )


def test_the_mcp_server_lists_the_tool(project):
    init = _rpc(project, "initialize", {"protocolVersion": "2025-06-18"})["result"]
    assert init["serverInfo"]["name"] == SERVER_KEY
    assert init["protocolVersion"] == "2025-06-18"
    assert "search_code" in init["instructions"]
    tools = _rpc(project, "tools/list")["result"]["tools"]
    assert [tool["name"] for tool in tools] == [TOOL_NAME]
    assert tools[0]["annotations"]["readOnlyHint"] is True


def test_the_mcp_server_answers_a_call(project):
    reply = _rpc(
        project,
        "tools/call",
        {"name": TOOL_NAME, "arguments": {"query": "over_budget"}},
    )
    content = reply["result"]["content"][0]["text"]
    assert reply["result"]["isError"] is False
    assert "app/budget.py:1-2 · over_budget (function)" in content


def test_the_mcp_server_refuses_what_it_does_not_serve(project):
    assert "error" in _rpc(
        project, "tools/call", {"name": "read_file", "arguments": {}}
    )
    assert "error" in _rpc(
        project, "tools/call", {"name": TOOL_NAME, "arguments": ["over_budget"]}
    )
    assert "error" in _rpc(project, "resources/list")
    assert (
        handle(project, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        is None
    )
    reply = _rpc(
        project, "tools/call", {"name": TOOL_NAME, "arguments": {"query": " "}}
    )
    assert reply["result"]["isError"] is True


def test_the_server_speaks_json_lines(project):
    stdin = io.StringIO(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) + "\nnot json\n"
    )
    stdout = io.StringIO()
    serve(project, stdin, stdout, warm=False)
    first, second = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert first["result"]["tools"] == TOOLS
    assert second["error"]["code"] == -32700


def test_a_page_fits_under_the_clients_mcp_cap(monkeypatch):
    assert page_chars() == PAGE_CHARS
    monkeypatch.setenv("MAX_MCP_OUTPUT_TOKENS", "1000")
    assert page_chars() == 3_000
    monkeypatch.setenv("MAX_MCP_OUTPUT_TOKENS", "100000")
    assert page_chars() == PAGE_CHARS


def test_the_runner_serves_one_project(project):
    config = mcp_server_config(project)
    assert config["command"] == sys.executable
    runner = Path(config["args"][0])
    assert runner == BACKEND / "runners" / "code_search_mcp.py" and runner.is_file()
    assert config["args"][1:] == ["--project-dir", str(project.resolve())]
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": TOOL_NAME, "arguments": {"query": "over_budget"}},
        },
    ]
    result = subprocess.run(
        [config["command"], *config["args"]],
        input="".join(json.dumps(m) + "\n" for m in messages),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert replies[0]["result"]["serverInfo"]["name"] == SERVER_KEY
    assert "over_budget (function)" in replies[1]["result"]["content"][0]["text"]


# --- create_client attaches it --------------------------------------------------------------


def _claude_options(monkeypatch, project: Path, agent_type: str) -> dict:
    client_module = importlib.import_module("core.client")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-valid-plaintext-token")
    monkeypatch.setattr(
        "core.auth.get_token_from_keychain", lambda _config_dir=None: None
    )
    captured: dict = {}

    class CapturingOptions:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    with (
        patch.object(client_module, "ClaudeAgentOptions", CapturingOptions),
        patch.object(client_module, "ClaudeSDKClient", return_value=MagicMock()),
    ):
        client_module.create_client(project, project, "claude-sonnet-4-5", agent_type)
    return captured


@pytest.mark.parametrize("agent_type", ["coder", "pr_reviewer"])
def test_create_client_starts_the_server_and_approves_its_tool(
    agent_type, project, monkeypatch
):
    options = _claude_options(monkeypatch, project, agent_type)
    assert options["mcp_servers"][SERVER_KEY] == mcp_server_config(project)
    assert MCP_TOOL_NAMES[0] in options["allowed_tools"]


def test_create_client_gives_nothing_to_a_type_that_does_not_declare_it(
    project, monkeypatch
):
    options = _claude_options(monkeypatch, project, "spec_researcher")
    assert SERVER_KEY not in options.get("mcp_servers", {})
    assert MCP_TOOL_NAMES[0] not in options["allowed_tools"]


def test_a_removed_server_leaves_no_approval_behind(project, monkeypatch):
    env = project / ".workpilot" / ".env"
    env.parent.mkdir(parents=True)
    env.write_text("AGENT_MCP_coder_REMOVE=code\n", encoding="utf-8")
    options = _claude_options(monkeypatch, project, "coder")
    assert SERVER_KEY not in options.get("mcp_servers", {})
    assert MCP_TOOL_NAMES[0] not in options["allowed_tools"]
