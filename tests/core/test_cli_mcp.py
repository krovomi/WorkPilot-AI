"""The project's custom MCP servers, handed to the CLIs that open them (lot E).

Codex, OpenCode and the ACP agents start a server themselves, so they get what
the Claude SDK gets: the servers kept for the agent type whose every tool is
approved. Each gets them in its own words, with no secret and no value a
Windows launcher could parse on its command line.
"""

from __future__ import annotations

import json

import core.cli_mcp as cli_mcp
import pytest
from core.cli_mcp import (
    OPENCODE_CONFIG_ENV,
    acp_mcp_servers,
    cli_mcp_servers,
    codex_mcp_overrides,
    opencode_config_content,
)
from mcp_pins import Verdict

REA = {
    "id": "rea",
    "name": "REA",
    "type": "command",
    "command": "npx",
    "args": ["-y", "rea-agents@6.9.0", "mcp"],
    "env": {"REA_MCP_TOOL_CATALOG_PROFILE": "hot-cold"},
}
REMOTE = {
    "id": "github",
    "name": "GitHub",
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {"Authorization": "Bearer ghp-test-0000"},  # pragma: allowlist secret
}


def test_codex_gets_plain_overrides_and_its_secrets_in_the_environment():
    args, env = codex_mcp_overrides([REA, REMOTE], base_env={"PATH": "/usr/bin"})
    overrides = args[1::2]
    assert set(args[0::2]) == {"-c"}
    assert overrides == [
        'mcp_servers.rea.command="npx"',
        'mcp_servers.rea.args=["-y","rea-agents@6.9.0","mcp"]',
        'mcp_servers.rea.env_vars=["REA_MCP_TOOL_CATALOG_PROFILE"]',
        'mcp_servers.github.url="https://api.githubcopilot.com/mcp/"',
        'mcp_servers.github.env_http_headers={"Authorization"="WORKPILOT_MCP_SECRET_1_0"}',
    ]
    assert env == {
        "REA_MCP_TOOL_CATALOG_PROFILE": "hot-cold",
        "WORKPILOT_MCP_SECRET_1_0": "Bearer ghp-test-0000",  # pragma: allowlist secret
    }
    assert not any("ghp-test" in a for a in args), "no secret on the command line"


@pytest.mark.parametrize(
    "change",
    [
        {"args": ["-y", "pkg & calc"]},  # cmd.exe would run calc
        {"args": ["%COMSPEC%"]},
        {"args": ['a"b']},
        {"id": "bad id"},
        {"env": {"OPENAI_API_KEY": "sk-other"}},  # pragma: allowlist secret
    ],
)
def test_codex_leaves_out_a_server_a_launcher_could_misread(change):
    server = {**REA, **change}
    args, env = codex_mcp_overrides(
        [server],
        base_env={"OPENAI_API_KEY": "sk-own"},  # pragma: allowlist secret
    )
    assert args == [] and env == {}


def test_codex_refuses_a_url_with_a_query_and_a_second_server_overriding_a_value():
    args, _ = codex_mcp_overrides([{**REMOTE, "url": "https://x.example/mcp?a=1&b=2"}])
    assert args == []
    other = {**REA, "id": "rea2", "env": {"REA_MCP_TOOL_CATALOG_PROFILE": "full"}}
    args, env = codex_mcp_overrides([REA, other])
    assert all("rea2" not in a for a in args)
    assert env == {"REA_MCP_TOOL_CATALOG_PROFILE": "hot-cold"}


def test_opencode_gets_its_mcp_block_merged_into_the_inline_config():
    current = json.dumps({"model": "anthropic/x", "mcp": {"mine": {"type": "local"}}})
    content = json.loads(opencode_config_content([REA, REMOTE], current))
    assert content["model"] == "anthropic/x"
    assert content["mcp"]["mine"] == {"type": "local"}
    assert content["mcp"]["rea"] == {
        "type": "local",
        "command": ["npx", "-y", "rea-agents@6.9.0", "mcp"],
        "enabled": True,
        "environment": {"REA_MCP_TOOL_CATALOG_PROFILE": "hot-cold"},
    }
    assert content["mcp"]["github"]["type"] == "remote"
    assert opencode_config_content([], "kept") == "kept"
    assert OPENCODE_CONFIG_ENV == "OPENCODE_CONFIG_CONTENT"


def test_acp_gets_http_only_when_the_agent_declares_it():
    stdio_only = acp_mcp_servers([REA, REMOTE], {"mcpCapabilities": {"http": False}})
    assert stdio_only == [
        {
            "name": "rea",
            "command": "npx",
            "args": ["-y", "rea-agents@6.9.0", "mcp"],
            "env": [{"name": "REA_MCP_TOOL_CATALOG_PROFILE", "value": "hot-cold"}],
        }
    ]
    both = acp_mcp_servers([REMOTE], {"mcpCapabilities": {"http": True}})
    assert both == [
        {
            "type": "http",
            "name": "github",
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": [
                {
                    "name": "Authorization",
                    "value": "Bearer ghp-test-0000",  # pragma: allowlist secret
                }
            ],
        }
    ]


def test_only_a_server_whose_every_tool_is_approved_reaches_a_cli(
    tmp_path, monkeypatch
):
    import core.mcp_pinning as pinning
    import core.mcp_tools as mcp_tools

    seen: list = []
    monkeypatch.setattr(
        mcp_tools,
        "load_mcp_server_configs_for",
        lambda agent_type, project_dir, spec_dir=None: (
            seen.append(agent_type) or [REA, REMOTE]
        ),
    )
    monkeypatch.setattr(pinning, "probe_tools", lambda project_dir, cfg: [])
    monkeypatch.setattr(
        pinning,
        "pin_verdicts",
        lambda project_dir, probed: {
            "rea": Verdict("rea", "approved"),
            "github": Verdict("github", "modified", held=("create_issue",)),
        },
    )
    assert cli_mcp_servers("analyzer", tmp_path) == [REA]
    assert seen == ["analyzer"]
    assert cli_mcp_servers("analyzer", None) == []


def test_a_lookup_that_fails_hands_nothing(tmp_path, monkeypatch):
    import core.mcp_tools as mcp_tools

    def broken(*_args, **_kwargs):
        raise OSError("unreadable .env")

    monkeypatch.setattr(mcp_tools, "load_mcp_server_configs_for", broken)
    assert cli_mcp_servers("coder", tmp_path) == []
    assert cli_mcp.logger.name == "core.cli_mcp"
