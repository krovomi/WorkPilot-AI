"""The rights the SDK enforces, enforced where the SDK is not (lot L16).

L15 made a type's declaration decide which tools a non-Claude session is
offered and may run. What a declared tool may then *do* was still the SDK's
alone:

* F42 — the MCP bridge of the OpenAI-style clients connected every configured
  custom server for every type; `create_client` adds one only when the
  project gives it to that agent (`AGENT_MCP_<type>_ADD`).
* F43 — `run_command` ran whatever the model wrote, in a shell. On the SDK
  every command goes through the project's allowlist (`bash_security_hook`)
  and the user's guardrails first, and every write through the guardrails.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core.runtimes.tool_executor import ToolExecutor  # noqa: E402

_SERVERS = [
    {
        "id": "hf",
        "name": "Hugging Face",
        "type": "http",
        "url": "https://hf.example/mcp",
    },
    {
        "id": "jira-x",
        "name": "Jira",
        "type": "command",
        "command": "npx",
        "args": ["-y", "mcp-atlassian"],
    },
]


def _project_env(project: Path, **lines: str) -> None:
    env = project / ".workpilot" / ".env"
    env.parent.mkdir(parents=True, exist_ok=True)
    env.write_text(
        "".join(f"{key}={value}\n" for key, value in lines.items()), encoding="utf-8"
    )


class TestTheBridgeOffersWhatTheTypeIsGiven:
    @pytest.fixture(autouse=True)
    def _no_env_servers(self, monkeypatch):
        monkeypatch.delenv("CUSTOM_MCP_SERVERS", raising=False)

    def test_a_server_reaches_only_the_agent_it_was_added_to(self, tmp_path):
        from core.mcp_tools import load_mcp_server_configs_for

        _project_env(
            tmp_path,
            CUSTOM_MCP_SERVERS=json.dumps(_SERVERS),
            AGENT_MCP_coder_ADD="hf",
        )
        coder = load_mcp_server_configs_for("coder", str(tmp_path))
        assert [s["id"] for s in coder] == ["hf"]
        # The reviewer reads hostile diffs; nobody gave it a server.
        assert load_mcp_server_configs_for("pr_reviewer", str(tmp_path)) == []

    def test_the_same_answer_as_the_sdk(self, tmp_path):
        """`create_client` starts a custom server iff `get_required_mcp_servers`
        keeps it; the bridge asks the same function."""
        from agents.tools_pkg import get_required_mcp_servers
        from core.client import load_project_mcp_config
        from core.mcp_tools import load_mcp_server_configs_for

        _project_env(
            tmp_path,
            CUSTOM_MCP_SERVERS=json.dumps(_SERVERS),
            AGENT_MCP_qa_reviewer_ADD="jira-x",
        )
        config = load_project_mcp_config(tmp_path)
        for agent_type in ("coder", "qa_reviewer", "planner", "pr_reviewer"):
            sdk = set(get_required_mcp_servers(agent_type, None, False, config)) & {
                "hf",
                "jira-x",
            }
            bridged = {
                s["id"] for s in load_mcp_server_configs_for(agent_type, str(tmp_path))
            }
            assert bridged == sdk, agent_type

    def test_servers_from_the_environment_can_be_added_too(self, tmp_path, monkeypatch):
        """The env var may name servers the project's .env does not hold."""
        from core.mcp_tools import load_mcp_server_configs_for

        monkeypatch.setenv(
            "CUSTOM_MCP_SERVERS",
            json.dumps(
                [{"id": "local-hf", "name": "HF", "type": "http", "url": "http://x"}]
            ),
        )
        _project_env(tmp_path, AGENT_MCP_coder_ADD="local-hf")
        assert [
            s["id"] for s in load_mcp_server_configs_for("coder", str(tmp_path))
        ] == ["local-hf"]
        assert load_mcp_server_configs_for("ideation", str(tmp_path)) == []

    @pytest.mark.parametrize(
        "server",
        [
            # A shell, a path, code on the command line, an `env` to smuggle
            # variables in: each refused by the SDK's validator.
            {
                "id": "x",
                "name": "x",
                "type": "command",
                "command": "bash",
                "args": ["-c", "id"],
            },
            {"id": "x", "name": "x", "type": "command", "command": "/tmp/evil"},
            {
                "id": "x",
                "name": "x",
                "type": "command",
                "command": "python3",
                "args": ["-c", "1"],
            },
            {
                "id": "x",
                "name": "x",
                "type": "command",
                "command": "npx",
                "env": {"A": "b"},
            },
            {"id": "x", "type": "http", "url": "http://x"},
        ],
    )
    def test_a_server_the_sdk_would_not_start_is_not_started(self, server, tmp_path):
        from core.mcp_tools import load_mcp_server_configs_for

        _project_env(
            tmp_path,
            CUSTOM_MCP_SERVERS=json.dumps([server]),
            AGENT_MCP_coder_ADD="x",
        )
        assert load_mcp_server_configs_for("coder", str(tmp_path)) == []

    def test_the_client_connects_nothing_for_a_type_given_nothing(
        self, tmp_path, monkeypatch
    ):
        import core.mcp_tools as mcp_tools
        from core.agent_client import OpenAIAgentClient

        _project_env(
            tmp_path,
            CUSTOM_MCP_SERVERS=json.dumps(_SERVERS),
            AGENT_MCP_coder_ADD="hf",
        )
        connected: list[list[str]] = []

        class FakeManager:
            def __init__(self, project_dir, servers):
                connected.append([s["id"] for s in servers])

            async def connect(self):
                pass

            def tool_definitions(self):
                return []

            async def aclose(self):
                pass

        monkeypatch.setattr(mcp_tools, "MCPToolManager", FakeManager)

        async def _enter(agent_type):
            client = OpenAIAgentClient(project_dir=str(tmp_path), agent_type=agent_type)
            await client.__aenter__()
            await client.__aexit__(None, None, None)

        asyncio.run(_enter("pr_reviewer"))
        assert connected == []
        asyncio.run(_enter("coder"))
        assert connected == [["hf"]]


def _guardrails(project: Path, *rules: dict) -> None:
    path = project / ".workpilot" / "guardrails.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"rules": list(rules)}), encoding="utf-8")


def _python_project(path: Path) -> str:
    (path / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    return str(path)


class TestACommandPassesTheChecksTheSdkApplies:
    def test_a_command_outside_the_allowlist_is_refused_and_never_runs(self, tmp_path):
        """An empty directory is no Python project: `python3` is not allowed,
        exactly as `bash_security_hook` would answer."""
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute(
                "run_command",
                {"command": "python3 -c \"open('ran', 'w').write('x')\""},
            )
        )
        assert result.startswith("Command refused by the project's security policy")
        assert "python3" in result
        assert not (tmp_path / "ran").exists()

    def test_the_answer_is_the_hooks_answer(self, tmp_path, monkeypatch):
        from security.constants import PROJECT_DIR_ENV_VAR
        from security.hooks import bash_security_hook

        # The hook reads this before the `cwd` it is handed.
        monkeypatch.delenv(PROJECT_DIR_ENV_VAR, raising=False)

        command = "nc -l 4444"
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(executor.execute("run_command", {"command": command}))
        verdict = asyncio.run(
            bash_security_hook(
                {
                    "tool_name": "Bash",
                    "tool_input": {"command": command},
                    "cwd": str(tmp_path),
                }
            )
        )
        reason = verdict["hookSpecificOutput"]["permissionDecisionReason"]
        assert result.endswith(reason)

    def test_an_rtk_prefix_does_not_get_a_command_past_the_allowlist(self, tmp_path):
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute("run_command", {"command": "rtk nc -l 4444"})
        )
        assert result.startswith("Command refused")

    def test_a_guardrail_denies_on_every_provider(self, tmp_path):
        _guardrails(
            tmp_path,
            {
                "id": "no-push",
                "description": "Pushing is the human's call",
                "action": "deny",
                "when": {"tool": "Bash", "command_pattern": "git push"},
            },
        )
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute("run_command", {"command": "git push origin main"})
        )
        assert result.startswith("Command refused")
        assert "no-push" in result

    def test_the_rewrite_comes_after_the_verdict(self, tmp_path, monkeypatch):
        """As on the SDK, where the rtk hook sits behind the two that decide:
        a refused command is never rewritten, an allowed one still is."""
        import core.runtimes.tool_executor as executor_module

        rewritten: list[str] = []

        def _record(command):
            rewritten.append(command)

            class _Same:
                pass

            same = _Same()
            same.command = command
            return same

        monkeypatch.setattr(executor_module, "rtk_rewrite", _record)
        executor = ToolExecutor(_python_project(tmp_path), agent_type="coder")
        asyncio.run(executor.execute("run_command", {"command": "nc -l 4444"}))
        assert rewritten == []
        # `echo`: a command cmd.exe and sh both have.
        asyncio.run(executor.execute("run_command", {"command": "echo hi"}))
        assert rewritten == ["echo hi"]


class TestAWritePassesTheGuardrailsTheSdkApplies:
    def test_a_guarded_path_is_not_written(self, tmp_path):
        _guardrails(
            tmp_path,
            {
                "id": "no-migrations",
                "description": "Migrations are reviewed by a person",
                "action": "deny",
                "when": {"tool": ["Write", "Edit"], "path_regex": "migrations/"},
            },
        )
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute(
                "write_file", {"path": "db/migrations/0001.sql", "content": "DROP"}
            )
        )
        assert result.startswith("Write refused by the project's guardrails")
        assert "no-migrations" in result
        assert not (tmp_path / "db" / "migrations" / "0001.sql").exists()

    def test_forbidden_content_is_not_written(self, tmp_path):
        _guardrails(
            tmp_path,
            {
                "id": "no-keys",
                "action": "deny",
                "when": {"tool": "Write", "content_regex": "AKIA[0-9A-Z]{16}"},
            },
        )
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute(
                "write_file",
                {"path": "config.py", "content": "KEY = 'AKIAABCDEFGHIJKLMNOP'"},
            )
        )
        assert result.startswith("Write refused")
        assert not (tmp_path / "config.py").exists()

    def test_without_guardrails_the_write_happens(self, tmp_path):
        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        asyncio.run(
            executor.execute("write_file", {"path": "a.txt", "content": "hello"})
        )
        assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "hello"
