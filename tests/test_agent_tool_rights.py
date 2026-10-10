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
