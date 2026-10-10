"""An agent type has the tools it declares — and no others.

`AGENT_CONFIGS[agent_type]["tools"]` became `allowed_tools`, which the Claude
SDK reads as "auto-approved", not as "the only tools that exist"; the settings
file `create_client` writes granted Write, Edit and `Bash(*)` to every type on
top of it. Outside the SDK, the tool executor offered `write_file` and
`run_command` to every type and ran whatever name a model sent. A
`pr_reviewer` reading a hostile pull request could therefore write files and
run commands on every provider.

`undeclared_builtin_tools` is the one answer to "what may this type not do",
and both halves read it: `create_client` and `create_simple_client` pass it as
`disallowed_tools`; the executor (later in this file) offers and runs only what
the type declares.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from agents.tools_pkg import (  # noqa: E402
    AGENT_CONFIGS,
    declared_tools,
    undeclared_builtin_tools,
)
from agents.tools_pkg.permissions import GUARDED_TOOLS  # noqa: E402

WRITE_FAMILY = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


class TestTheDeclarationIsTheRight:
    def test_a_reviewer_may_neither_write_nor_run(self):
        denied = set(undeclared_builtin_tools("pr_reviewer"))
        assert WRITE_FAMILY | {"Bash"} <= denied
        assert not denied & {"WebFetch", "WebSearch"}, "it declares the web"

    def test_the_coder_is_denied_nothing(self):
        assert undeclared_builtin_tools("coder") == []

    def test_a_write_only_author_keeps_write_and_loses_the_shell(self):
        """archify: the model writes the JSON, Python runs the renderer."""
        denied = set(undeclared_builtin_tools("architecture_visualizer"))
        assert "Write" not in denied
        assert {"Bash", "Edit", "MultiEdit"} <= denied

    def test_a_text_only_call_is_denied_every_guarded_tool(self):
        assert set(undeclared_builtin_tools("commit_message")) == set(GUARDED_TOOLS)

    def test_an_unregistered_type_is_left_alone(self):
        """Every product agent_type is registered (the AST test in
        `test_agent_type_registry`); refusing an unknown one would break tests
        and outside callers without protecting anything."""
        assert declared_tools("not-a-type") is None
        assert undeclared_builtin_tools("not-a-type") == []

    @pytest.mark.parametrize("agent_type", sorted(AGENT_CONFIGS))
    def test_nothing_declared_is_ever_denied(self, agent_type):
        declared = set(AGENT_CONFIGS[agent_type].get("tools", []))
        for tool in undeclared_builtin_tools(agent_type):
            assert GUARDED_TOOLS[tool] not in declared, (agent_type, tool)

    def test_every_read_only_type_is_denied_writes_and_the_shell(self):
        from core.client import READ_ONLY_AGENT_TYPES

        for agent_type in READ_ONLY_AGENT_TYPES:
            denied = set(undeclared_builtin_tools(agent_type))
            assert WRITE_FAMILY | {"Bash"} <= denied, agent_type


def _capture_claude_options(monkeypatch, build):
    """Run a client factory and return the kwargs it gave ClaudeAgentOptions."""
    import core.client as client_module
    import core.simple_client as simple_module

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
        patch.object(simple_module, "ClaudeAgentOptions", CapturingOptions),
        patch.object(client_module, "ClaudeSDKClient", return_value=MagicMock()),
        patch.object(simple_module, "ClaudeSDKClient", return_value=MagicMock()),
    ):
        build()
    return captured


class TestTheClaudeClientDeniesIt:
    def test_create_client_denies_a_reviewer_its_undeclared_tools(
        self, tmp_path, monkeypatch
    ):
        from core.client import create_client

        options = _capture_claude_options(
            monkeypatch,
            lambda: create_client(
                tmp_path, tmp_path, "claude-sonnet-4-5", "pr_reviewer"
            ),
        )
        assert WRITE_FAMILY | {"Bash"} <= set(options["disallowed_tools"])
        # Read-only types keep plan mode on top: two barriers, not one.
        assert options["permission_mode"] == "plan"

    def test_create_client_denies_the_coder_nothing(self, tmp_path, monkeypatch):
        from core.client import create_client

        options = _capture_claude_options(
            monkeypatch,
            lambda: create_client(tmp_path, tmp_path, "claude-sonnet-4-5", "coder"),
        )
        assert "disallowed_tools" not in options

    def test_the_simple_client_denies_a_commit_message_every_guarded_tool(
        self, tmp_path, monkeypatch
    ):
        """It loads the user's and the project's settings files, whose allow
        rules could grant what `commit_message` (no tools) never declared."""
        from core.simple_client import create_simple_client

        options = _capture_claude_options(
            monkeypatch,
            lambda: create_simple_client(
                agent_type="commit_message", model="claude-haiku-4-5", cwd=tmp_path
            ),
        )
        assert set(options["disallowed_tools"]) == set(GUARDED_TOOLS)


# --- The executor: Copilot, OpenAI, Gemini, local models, Windsurf, LiteLLM ---


def _offered(agent_type: str) -> set[str]:
    from core.runtimes.tool_executor import get_tool_definitions

    return {tool["name"] for tool in get_tool_definitions(agent_type)}


class TestTheExecutorOffersOnlyWhatIsDeclared:
    @pytest.mark.parametrize("agent_type", ["pr_reviewer", "insights", "spec_critic"])
    def test_a_read_only_type_can_read_and_search_but_not_write_or_run(
        self, agent_type
    ):
        offered = _offered(agent_type)
        assert {"read_file", "list_files", "search_files", "find_files"} <= offered
        assert not offered & {"write_file", "Write", "create_directory", "run_command"}

    def test_the_coder_keeps_everything(self):
        assert {
            "read_file",
            "write_file",
            "run_command",
            "create_directory",
            "search_files",
            "find_files",
        } <= _offered("coder")

    def test_the_planner_keeps_the_write_alias_its_prompt_names(self):
        assert {"Write", "write_file", "run_command"} <= _offered("planner")

    def test_a_write_only_author_gets_no_shell(self):
        offered = _offered("architecture_visualizer")
        assert "write_file" in offered
        assert "run_command" not in offered

    def test_an_unregistered_type_keeps_the_base_tools(self):
        """`test_tool_definitions` pins this for callers outside the product."""
        assert {"read_file", "write_file", "list_files", "run_command"} <= _offered(
            "not-a-type"
        )


class TestTheExecutorRefusesWhatWasNeverOffered:
    """Native `tool_calls` are not checked against the tools a client offered,
    so hiding a tool is not enough: the executor is the one choke point."""

    @staticmethod
    def _run(executor, name, args):
        import asyncio

        return asyncio.run(executor.execute(name, args))

    def test_a_reviewer_cannot_write_even_by_naming_the_tool(self, tmp_path):
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(tmp_path), agent_type="pr_reviewer")
        result = self._run(executor, "write_file", {"path": "x.txt", "content": "y"})
        assert "not available to this agent" in result
        assert not (tmp_path / "x.txt").exists()

    def test_a_reviewer_cannot_run_a_command(self, tmp_path):
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(tmp_path), agent_type="pr_reviewer")
        result = self._run(executor, "run_command", {"command": "touch pwned"})
        assert "not available to this agent" in result
        assert not (tmp_path / "pwned").exists()

    def test_the_coder_still_writes(self, tmp_path):
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        self._run(executor, "write_file", {"path": "x.txt", "content": "y"})
        assert (tmp_path / "x.txt").read_text(encoding="utf-8") == "y"

    def test_an_executor_without_a_type_is_unchanged(self, tmp_path):
        from core.runtimes.tool_executor import ToolExecutor

        self._run(
            ToolExecutor(str(tmp_path)), "write_file", {"path": "x", "content": "y"}
        )
        assert (tmp_path / "x").exists()


class TestTheReadOnlySearch:
    """What a reviewer searches with once `run_command` is gone."""

    @staticmethod
    def _run(executor, name, args):
        import asyncio

        return asyncio.run(executor.execute(name, args))

    @pytest.fixture
    def project(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "orders.py").write_text(
            "def create_order():\n    return 42\n", encoding="utf-8"
        )
        (tmp_path / "README.md").write_text(
            "create_order is documented\n", encoding="utf-8"
        )
        (tmp_path / "node_modules").mkdir()
        (tmp_path / "node_modules" / "dep.js").write_text(
            "create_order()\n", encoding="utf-8"
        )
        (tmp_path / "blob.bin").write_bytes(b"create_order\x00\x01")
        return tmp_path

    def test_it_finds_lines_and_skips_dependencies_and_binaries(self, project):
        from core.runtimes.tool_executor import ToolExecutor

        result = self._run(
            ToolExecutor(str(project), agent_type="pr_reviewer"),
            "search_files",
            {"pattern": r"create_order"},
        )
        assert "src/orders.py:1: def create_order():" in result
        assert "README.md:1:" in result
        assert "node_modules" not in result
        assert "blob.bin" not in result

    def test_a_glob_narrows_it(self, project):
        from core.runtimes.tool_executor import ToolExecutor

        result = self._run(
            ToolExecutor(str(project), agent_type="pr_reviewer"),
            "search_files",
            {"pattern": "create_order", "glob": "**/*.py"},
        )
        assert "src/orders.py" in result
        assert "README.md" not in result

    def test_find_files_matches_paths_root_included(self, project):
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(project), agent_type="pr_reviewer")
        assert self._run(executor, "find_files", {"pattern": "**/*.py"}) == (
            "src/orders.py"
        )
        assert "README.md" in self._run(executor, "find_files", {"pattern": "**/*.md"})

    def test_it_never_leaves_the_project(self, project):
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(project), agent_type="pr_reviewer")
        with pytest.raises(ValueError, match="outside the project"):
            self._run(executor, "search_files", {"pattern": "x", "directory": ".."})

    def test_it_does_not_follow_a_link_out_of_the_project(
        self, project, tmp_path_factory
    ):
        from core.runtimes.tool_executor import ToolExecutor

        outside = tmp_path_factory.mktemp("outside")
        (outside / "secret.txt").write_text("create_order secret\n", encoding="utf-8")
        try:
            (project / "link").symlink_to(outside, target_is_directory=True)
        except OSError:
            pytest.skip("symlinks unavailable")
        result = self._run(
            ToolExecutor(str(project), agent_type="pr_reviewer"),
            "search_files",
            {"pattern": "secret"},
        )
        assert result == "(no matches found)"

    def test_an_invalid_pattern_says_so(self, project):
        from core.runtimes.tool_executor import ToolExecutor

        with pytest.raises(ValueError, match="Invalid regular expression"):
            self._run(
                ToolExecutor(str(project), agent_type="pr_reviewer"),
                "search_files",
                {"pattern": "("},
            )


class TestCodexSandbox:
    """Codex brings its own tools, so the executor never sees its calls: the
    sandbox is the one lever, chosen from the same declaration."""

    def test_a_reviewer_runs_read_only(self):
        from core.codex_cli_client import codex_sandbox_for

        assert codex_sandbox_for("pr_reviewer") == "read-only"
        assert codex_sandbox_for("coder") == "workspace-write"
        assert codex_sandbox_for("not-a-type") == "workspace-write"

    def test_the_sandbox_reaches_the_command_line(self, tmp_path):
        from core.codex_cli_client import build_codex_exec_args

        args = build_codex_exec_args(
            executable="codex",
            project_dir=tmp_path,
            model=None,
            reasoning_effort=None,
            prompt="review",
            thread_id=None,
            sandbox="read-only",
        )
        assert args[args.index("--sandbox") + 1] == "read-only"

    def test_an_unknown_sandbox_value_falls_back_to_the_known_default(self, tmp_path):
        from core.codex_cli_client import build_codex_exec_args

        args = build_codex_exec_args(
            executable="codex",
            project_dir=tmp_path,
            model=None,
            reasoning_effort=None,
            prompt="x",
            thread_id=None,
            sandbox="danger-full-access",
        )
        assert args[args.index("--sandbox") + 1] == "workspace-write"
