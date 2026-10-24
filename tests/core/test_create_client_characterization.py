"""What `create_client` hands the Claude Agent SDK, pinned before its split.

`create_client` is one function of more than nine hundred lines: the CLI's
environment, the permission file, the MCP servers, the hooks, the subagent
roster, the resume pointer and the per-type restrictions. These tests build a
client with the SDK classes replaced and read what reached
`ClaudeAgentOptions` and the settings file. They were written green against
the function before its split, and the split keeps them green.

Fake credentials are assembled at runtime: a literal shaped like a key is
what the pre-commit secret scan looks for.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_FAKE = "test-" + "0" * 24

_ENV_TO_CLEAR = (
    "AUTO_CLAUDE_OTEL_ENDPOINT",
    "AUTO_CLAUDE_RESUME_SESSION_ID",
    "AUTO_CLAUDE_MAX_TURNS",
    "AUTO_CLAUDE_EFFORT",
    "AUTO_CLAUDE_AGENT_DEBUGGER",
    "CLAUDE_CLI_PATH",
    "CONTEXT7_API_KEY",
    "CHROME_DEVTOOLS_PORT",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "JIRA_URL",
    "JIRA_USERNAME",
    "JIRA_API_TOKEN",
    "LINEAR_API_KEY",
)


class _Harness:
    def __init__(self, client_module, tmp_path: Path) -> None:
        self.module = client_module
        self.project_dir = tmp_path / "project"
        self.project_dir.mkdir()
        self.spec_dir = self.project_dir / ".workpilot" / "specs" / "001-task"
        self.spec_dir.mkdir(parents=True)
        self.servers: list[str] = []
        self.mcp_config: dict = {}
        self.sdk_env: dict[str, str] = {}
        self.roster: dict | None = None
        self.roster_error: Exception | None = None
        self.resolve_calls: list[dict] = []
        self.undeclared: list[str] = []
        self.options: dict = {}

    def build(self, agent_type: str = "coder", **kwargs) -> dict:
        kwargs.setdefault("project_dir", self.project_dir)
        kwargs.setdefault("spec_dir", self.spec_dir)
        kwargs.setdefault("model", "claude-sonnet-test")
        self.module.create_client(agent_type=agent_type, **kwargs)
        return self.options

    def settings(self) -> dict:
        return json.loads(
            (self.project_dir / ".claude_settings.json").read_text(encoding="utf-8")
        )

    def allowed(self) -> list[str]:
        return self.settings()["permissions"]["allow"]


@pytest.fixture
def harness(tmp_path: Path, monkeypatch):
    module = importlib.import_module("core.client")
    state = _Harness(module, tmp_path)
    for name in _ENV_TO_CLEAR:
        monkeypatch.delenv(name, raising=False)

    class CapturingOptions:
        def __init__(self, **kwargs):
            state.options = kwargs

    def resolve(agent_type, **kwargs):
        state.resolve_calls.append({"agent_type": agent_type, **kwargs})
        if state.roster_error is not None:
            raise state.roster_error
        return state.roster

    patches = {
        "ClaudeAgentOptions": CapturingOptions,
        "ClaudeSDKClient": MagicMock(),
        "configure_sdk_authentication": lambda *_args: None,
        "get_sdk_env_vars": lambda: dict(state.sdk_env),
        "is_linear_enabled": lambda: False,
        "is_tools_available": lambda: False,
        "_get_cached_project_data": lambda _dir: ({}, {}),
        "load_project_mcp_config": lambda _dir: state.mcp_config,
        "get_allowed_tools": lambda *_a, **_k: ["Read", "Write", "Bash"],
        "get_required_mcp_servers": lambda *_a, **_k: list(state.servers),
        "undeclared_builtin_tools": lambda _type: list(state.undeclared),
        "_get_active_provider": lambda _spec: "claude",
    }
    for name, value in patches.items():
        monkeypatch.setattr(module, name, value)

    import agents.subagents as subagents
    import core.llm_optimization as llm_optimization

    monkeypatch.setattr(subagents, "resolve", resolve)
    monkeypatch.setattr(
        llm_optimization, "build_base_system_prompt", lambda _dir: "BASE PROMPT"
    )
    return state


# -- The permission file -------------------------------------------------------


def test_the_settings_file_confines_file_tools_to_the_project(harness):
    options = harness.build()

    settings = harness.settings()
    assert settings["sandbox"] == {"enabled": True, "autoAllowBashIfSandboxed": True}
    assert settings["permissions"]["defaultMode"] == "acceptEdits"
    project = str(harness.project_dir.resolve())
    spec = str(harness.spec_dir.resolve())
    assert harness.allowed() == [
        "Read(./**)",
        "Write(./**)",
        "Edit(./**)",
        "Glob(./**)",
        "Grep(./**)",
        f"Read({project}/**)",
        f"Write({project}/**)",
        f"Edit({project}/**)",
        f"Glob({project}/**)",
        f"Grep({project}/**)",
        f"Read({spec}/**)",
        f"Write({spec}/**)",
        f"Edit({spec}/**)",
        "Bash(*)",
        "WebFetch(*)",
        "WebSearch(*)",
    ]
    assert options["settings"] == str(
        (harness.project_dir / ".claude_settings.json").resolve()
    )
    assert options["cwd"] == project


def test_a_worktree_may_reach_its_main_checkouts_workpilot_dir(harness, tmp_path):
    main = tmp_path / "main"
    (main / ".workpilot").mkdir(parents=True)
    worktree = main / ".workpilot" / "worktrees" / "tasks" / "001-task"
    worktree.mkdir(parents=True)

    harness.build(project_dir=worktree)

    allowed = json.loads(
        (worktree / ".claude_settings.json").read_text(encoding="utf-8")
    )["permissions"]["allow"]
    root = str((main / ".workpilot").resolve())
    granted = [rule for rule in allowed if rule.endswith(f"({root}/**)")]
    assert granted == [
        f"{op}({root}/**)" for op in ("Read", "Write", "Edit", "Glob", "Grep")
    ]
    # The legacy directory is granted only when it exists.
    assert not any(".worktrees/**" in rule for rule in allowed)


def test_a_servers_tools_are_approved_only_when_it_is_started(harness):
    from agents.tools_pkg import CONTEXT7_TOOLS, LINEAR_TOOLS

    harness.build()
    assert not any(rule.startswith("mcp__") for rule in harness.allowed())

    harness.servers = ["context7", "linear"]
    harness.build()
    allowed = harness.allowed()
    assert [f"{tool}(*)" for tool in CONTEXT7_TOOLS] == [
        rule for rule in allowed if rule[:-3] in CONTEXT7_TOOLS
    ]
    assert all(f"{tool}(*)" in allowed for tool in LINEAR_TOOLS)


def test_browser_tools_follow_the_browser_server(harness):
    from agents.tools_pkg import ELECTRON_TOOLS, PUPPETEER_TOOLS

    harness.servers = ["electron", "puppeteer"]
    harness.build()

    allowed = harness.allowed()
    assert all(f"{tool}(*)" in allowed for tool in ELECTRON_TOOLS)
    assert not any(f"{tool}(*)" in allowed for tool in PUPPETEER_TOOLS)


# -- MCP servers ---------------------------------------------------------------


def test_no_server_is_started_unless_required(harness):
    assert harness.build()["mcp_servers"] == {}


def test_the_context7_key_travels_in_the_environment(harness, monkeypatch):
    harness.servers = ["context7"]
    assert harness.build()["mcp_servers"]["context7"] == {
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"],
    }

    monkeypatch.setenv("CONTEXT7_API_KEY", _FAKE)
    server = harness.build()["mcp_servers"]["context7"]
    assert server["env"] == {"CONTEXT7_API_KEY": _FAKE}
    assert _FAKE not in server["args"]

    harness.mcp_config = {"CONTEXT7_API_KEY": "project-" + _FAKE}
    server = harness.build()["mcp_servers"]["context7"]
    assert server["env"] == {"CONTEXT7_API_KEY": "project-" + _FAKE}


def test_chrome_devtools_is_headless_without_a_browser_to_join(harness, monkeypatch):
    harness.servers = ["chrome-devtools"]
    base = ["-y", "chrome-devtools-mcp@latest", "--no-usage-statistics"]
    base.append("--no-performance-crux")

    assert harness.build()["mcp_servers"]["chrome-devtools"] == {
        "command": "npx",
        "args": [*base, "--headless"],
    }

    monkeypatch.setenv("CHROME_DEVTOOLS_PORT", "9333")
    args = harness.build()["mcp_servers"]["chrome-devtools"]["args"]
    assert args == [*base, "--browser-url=http://127.0.0.1:9333"]


def test_linear_is_reached_over_http_with_its_key(harness, monkeypatch):
    monkeypatch.setenv("LINEAR_API_KEY", _FAKE)
    harness.servers = ["linear"]

    assert harness.build()["mcp_servers"]["linear"] == {
        "type": "http",
        "url": "https://mcp.linear.app/mcp",
        "headers": {"Authorization": f"Bearer {_FAKE}"},
    }


def test_a_server_that_needs_a_credential_waits_for_it(harness, monkeypatch):
    harness.servers = ["github", "jira", "electron", "puppeteer"]
    servers = harness.build()["mcp_servers"]
    assert set(servers) == {"electron", "puppeteer"}

    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", _FAKE)
    monkeypatch.setenv("JIRA_URL", "https://jira.example.test")
    monkeypatch.setenv("JIRA_USERNAME", "someone")
    servers = harness.build()["mcp_servers"]
    assert servers["github"]["env"] == {"GITHUB_PERSONAL_ACCESS_TOKEN": _FAKE}
    assert "jira" not in servers  # still one of its three settings short

    monkeypatch.setenv("JIRA_API_TOKEN", _FAKE)
    assert harness.build()["mcp_servers"]["jira"]["env"] == {
        "JIRA_URL": "https://jira.example.test",
        "JIRA_USERNAME": "someone",
        "JIRA_API_TOKEN": _FAKE,
    }


def test_custom_servers_start_only_when_the_type_requires_them(harness):
    harness.mcp_config = {
        "CUSTOM_MCP_SERVERS": [
            {"id": "local-tool", "command": "node", "args": ["server.js"]},
            {
                "id": "remote",
                "type": "http",
                "url": "https://mcp.example.test",
                "headers": {"X-Team": "a"},
            },
            {"id": "unused", "command": "node"},
            {"command": "no-id"},
        ]
    }
    harness.servers = ["local-tool", "remote"]

    assert harness.build()["mcp_servers"] == {
        "local-tool": {"command": "node", "args": ["server.js"]},
        "remote": {
            "type": "http",
            "url": "https://mcp.example.test",
            "headers": {"X-Team": "a"},
        },
    }


# -- Hooks ---------------------------------------------------------------------


def test_the_hooks_run_in_their_documented_order(harness):
    from harness.application.subagents import SUBAGENT_TOOLS
    from rtk import rtk_rewrite_hook
    from security import bash_security_hook
    from security.path_guard import GUARDED_WRITE_TOOLS
    from watermarks import CLEANED_TOOLS

    hooks = harness.build()["hooks"]

    pre = hooks["PreToolUse"]
    assert [m.matcher for m in pre] == [
        "Bash",
        "Bash",
        "Bash",
        *GUARDED_WRITE_TOOLS,
        "Read",
        *GUARDED_WRITE_TOOLS,
        *CLEANED_TOOLS,
    ]
    assert pre[0].hooks == [bash_security_hook]
    assert pre[2].hooks == [rtk_rewrite_hook]
    assert all(len(m.hooks) == 1 for m in pre)
    assert [m.matcher for m in hooks["PostToolUse"]] == list(SUBAGENT_TOOLS)
    assert len(hooks["PreCompact"]) == 1
    assert len(hooks["Stop"]) == 1


# -- Options -------------------------------------------------------------------


def test_the_session_defaults(harness):
    options = harness.build(max_thinking_tokens=5000)

    assert options["model"] == "claude-sonnet-test"
    assert options["system_prompt"].startswith("BASE PROMPT")
    assert options["allowed_tools"] == ["Read", "Write", "Bash"]
    assert options["max_turns"] == 1000
    assert options["max_thinking_tokens"] == 5000
    assert options["max_buffer_size"] == 10 * 1024 * 1024
    assert options["enable_file_checkpointing"] is True
    assert options["setting_sources"] == ["project", "user", "local"]
    for absent in ("output_format", "cli_path", "resume", "permission_mode"):
        assert absent not in options
    for absent in ("agents", "disallowed_tools", "effort"):
        assert absent not in options


def test_the_turn_cap_and_output_format_follow_the_caller(harness, monkeypatch):
    monkeypatch.setenv("AUTO_CLAUDE_MAX_TURNS", "7")
    schema = {"type": "json_schema", "schema": {"type": "object"}}

    options = harness.build(output_format=schema)

    assert options["max_turns"] == 7
    assert options["output_format"] == schema


def test_the_cli_environment(harness, monkeypatch):
    env = harness.build()["env"]
    assert env["ENABLE_PROMPT_CACHING_1H"] == "1"
    assert not any(key.startswith("OTEL_") for key in env)
    assert "CLAUDE_CODE_DISABLE_AUTO_MEMORY" not in env

    monkeypatch.setenv("AUTO_CLAUDE_OTEL_ENDPOINT", "http://localhost:4318")
    harness.sdk_env = {"CLAUDE_CONFIG_DIR": str(harness.project_dir / "profile")}
    env = harness.build(agent_type="planner")["env"]
    assert env["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://localhost:4318"
    assert env["OTEL_SERVICE_NAME"] == "workpilot-planner"
    assert env["CLAUDE_CODE_ENABLE_TELEMETRY"] == "1"
    assert env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] == "1"


def test_a_cli_override_is_used_only_when_valid(harness, monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_PATH", "/opt/claude/bin/claude")
    monkeypatch.setattr(harness.module, "validate_cli_path", lambda _path: False)
    assert "cli_path" not in harness.build()

    monkeypatch.setattr(harness.module, "validate_cli_path", lambda _path: True)
    assert harness.build()["cli_path"] == "/opt/claude/bin/claude"


def test_a_read_only_type_runs_in_plan_mode(harness):
    assert "permission_mode" not in harness.build("coder")
    assert harness.build("pr_reviewer")["permission_mode"] == "plan"


def test_undeclared_tools_are_refused(harness):
    harness.undeclared = ["Write", "Edit"]

    assert harness.build()["disallowed_tools"] == ["Write", "Edit"]


# -- Subagents -----------------------------------------------------------------


def test_a_roster_brings_the_agent_tool(harness):
    harness.roster = {"tester": {"description": "d", "prompt": "Run the tests."}}

    options = harness.build(roster="qa")

    assert list(options["agents"]) == ["tester"]
    assert options["agents"]["tester"]["prompt"].startswith("Run the tests.")
    assert options["allowed_tools"][-1] == "Agent"
    assert harness.resolve_calls[0]["agent_type"] == "coder"
    assert harness.resolve_calls[0]["roster_name"] == "qa"
    assert harness.resolve_calls[0]["provider"] == "claude"


def test_a_phase_without_dispatch_gets_no_roster(harness):
    harness.roster = {"tester": {"description": "d", "prompt": "p"}}

    options = harness.build(use_subagents=False)

    assert harness.resolve_calls == []
    assert "agents" not in options
    assert "Agent" not in options["allowed_tools"]


def test_a_failed_roster_falls_back_to_the_callers_agents(harness):
    harness.roster_error = RuntimeError("registry unreadable")
    mine = {"helper": {"description": "d", "prompt": "Help."}}

    options = harness.build(agents=mine)

    assert list(options["agents"]) == ["helper"]
    assert "Agent" in options["allowed_tools"]


# -- Resume --------------------------------------------------------------------


def test_an_explicit_resume_is_passed_as_given(harness):
    assert harness.build(resume="explicit-session")["resume"] == "explicit-session"


def test_the_resume_variable_is_consumed_once(harness, monkeypatch):
    profile = harness.project_dir / "profile"
    (profile / "projects" / "encoded").mkdir(parents=True)
    (profile / "projects" / "encoded" / "abc-123.jsonl").write_text("{}")
    harness.sdk_env = {"CLAUDE_CONFIG_DIR": str(profile)}
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "abc-123")

    assert harness.build()["resume"] == "abc-123"
    assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in os.environ
    assert "resume" not in harness.build()


def test_a_resume_without_a_transcript_is_dropped(harness, monkeypatch):
    harness.sdk_env = {"CLAUDE_CONFIG_DIR": str(harness.project_dir / "empty")}
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "missing-session")

    assert "resume" not in harness.build()
    assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in os.environ
