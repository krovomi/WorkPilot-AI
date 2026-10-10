"""Only the two factories build Claude SDK options (audit lot L16, F41).

L15 made a type's declaration a right inside `create_client` and
`create_simple_client`: what a type does not declare is passed as
`disallowed_tools`. Eight call sites built `ClaudeAgentOptions` themselves and
passed nothing of the kind — an empty `allowed_tools` is an approval list, not
a barrier — so the user's and the project's settings files decided what the
insights chat, the voice and git runners, the code playground, the Linear
updater and the PR follow-up review could run.

`create_simple_client` installs no hook, so it now refuses a type that
declares a command or a write; the follow-up planner, which reached it through
`ClaudeSDKRuntime` with the planner's Write, Edit and Bash, plans through
`create_agent_client` like the first planning session.
"""

from __future__ import annotations

import ast
import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from agents.tools_pkg import (  # noqa: E402
    AGENT_CONFIGS,
    LINEAR_TOOLS,
    hooked_grants,
)
from agents.tools_pkg.permissions import GUARDED_TOOLS  # noqa: E402

_SKIP_DIRS = {"vendor", "__pycache__", "node_modules", ".venv", "tests"}

#: The two modules allowed to build options.
FACTORIES = {
    Path("apps/backend/core/client.py"),
    Path("apps/backend/core/simple_client.py"),
}

#: Builders that are not factories but are known and dated. Each entry names
#: the lot that removes it; the test fails once the file is gone, so the
#: exemption goes with it.
KNOWN_OUTSIDERS = {
    # F32 (lot L9): a second provider registry. `generate` calls
    # `ClaudeSDKClient.query_sync`, which the SDK has never had, so the
    # options it builds never reach a session.
    Path("src/connectors/llm_claude.py"),
}

_BUILDERS = {"ClaudeAgentOptions", "ClaudeSDKClient"}


def _sources():
    for root in (BACKEND, REPO_ROOT / "src"):
        for path in sorted(root.rglob("*.py")):
            rel = path.relative_to(REPO_ROOT)
            if _SKIP_DIRS.intersection(rel.parts):
                continue
            if path.name.startswith("test_") or path.name == "conftest.py":
                continue
            yield rel, path


def _callee(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _calls():
    for rel, path in _sources():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                yield rel, node


def _literal_agent_type(node: ast.Call, default: str | None = None) -> str | None:
    for kw in node.keywords:
        if kw.arg == "agent_type":
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                return kw.value.value
            return None  # computed: not this test's to judge
    return default


class TestOnlyTheFactoriesBuildOptions:
    def test_no_options_are_built_outside_the_factories(self):
        outside = sorted(
            f"{rel}:{node.lineno} {_callee(node)}(…)"
            for rel, node in _calls()
            if _callee(node) in _BUILDERS
            and rel not in FACTORIES
            and rel not in KNOWN_OUTSIDERS
        )
        assert not outside, (
            "Build the client with core.client.create_client (or "
            "core.simple_client.create_simple_client) and a registered "
            "agent_type: these sessions get no denial and no hook.\n"
            + "\n".join(outside)
        )

    @pytest.mark.parametrize("rel", sorted(KNOWN_OUTSIDERS), ids=str)
    def test_every_exemption_still_has_its_file(self, rel):
        assert (REPO_ROOT / rel).exists(), (
            f"{rel} is gone: remove it from KNOWN_OUTSIDERS"
        )


class TestTheSimpleClientServesNoHookedType:
    @pytest.mark.parametrize(
        "agent_type",
        sorted(t for t in AGENT_CONFIGS if hooked_grants(t)),
    )
    def test_a_type_that_writes_or_runs_commands_is_refused(self, agent_type):
        from core.simple_client import create_simple_client

        with pytest.raises(ValueError, match="create_client"):
            create_simple_client(agent_type=agent_type)

    def test_every_literal_simple_client_type_is_hookless(self):
        """The refusal fires at run time; this catches the call in review."""
        hooked = sorted(
            f"{rel}:{node.lineno} {agent_type} declares {hooked_grants(agent_type)}"
            for rel, node in _calls()
            if _callee(node) == "create_simple_client"
            and (agent_type := _literal_agent_type(node, "merge_resolver"))
            and hooked_grants(agent_type)
        )
        assert not hooked, "\n".join(hooked)

    def test_every_literal_runtime_type_is_hookless(self):
        """`create_agent_runtime` serves Claude through `ClaudeSDKRuntime`,
        which is a simple client. The follow-up planner reached it with
        `planner`; it plans through `create_agent_client` now."""
        hooked = sorted(
            f"{rel}:{node.lineno} {agent_type}"
            for rel, node in _calls()
            if _callee(node) == "create_agent_runtime"
            and (agent_type := _literal_agent_type(node))
            and hooked_grants(agent_type)
        )
        assert not hooked, "\n".join(hooked)

    def test_spec_compaction_is_text_only(self):
        """One phase output in the prompt, a summary out, in one turn."""
        assert AGENT_CONFIGS["spec_compaction"]["tools"] == []

    def test_an_unknown_type_is_still_refused_by_the_registry(self):
        from core.simple_client import create_simple_client

        with pytest.raises(ValueError, match="Unknown agent type"):
            create_simple_client(agent_type="not-a-type")


def _capture_options(monkeypatch, build):
    """Run something that builds a client; return its options kwargs.

    The modules are taken from `sys.modules`, which is where the code under
    test imports them from. `import core.simple_client as m` reads the `core`
    package's attribute instead, and test modules that swap `sys.modules`
    entries and restore them (test_qa_loop, test_spec_phases…) can leave that
    attribute naming an older module object than the one in use.
    """
    client_module = importlib.import_module("core.client")
    simple_module = importlib.import_module("core.simple_client")

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


class TestTheTypeDecidesTheServers:
    def test_a_declared_server_is_started_and_its_tools_approved(
        self, tmp_path, monkeypatch
    ):
        from core.simple_client import create_simple_client

        server = {"type": "http", "url": "https://mcp.linear.app/mcp"}
        options = _capture_options(
            monkeypatch,
            lambda: create_simple_client(
                agent_type="linear_updater",
                cwd=tmp_path,
                mcp_servers={"linear": server},
            ),
        )
        assert options["mcp_servers"] == {"linear": server}
        assert set(LINEAR_TOOLS) <= set(options["allowed_tools"])
        assert set(options["disallowed_tools"]) == set(GUARDED_TOOLS)

    def test_an_undeclared_server_is_refused(self, tmp_path):
        from core.simple_client import create_simple_client

        with pytest.raises(ValueError, match="does not declare the MCP server"):
            create_simple_client(
                agent_type="commit_message",
                cwd=tmp_path,
                mcp_servers={"linear": {"type": "http", "url": "x"}},
            )

    def test_no_server_is_started_unless_one_is_handed_over(
        self, tmp_path, monkeypatch
    ):
        from core.simple_client import create_simple_client

        options = _capture_options(
            monkeypatch,
            lambda: create_simple_client(agent_type="insights", cwd=tmp_path),
        )
        assert "mcp_servers" not in options


class TestEveryApprovedMcpToolNamesAServerTheSessionHas:
    """An approval for `mcp__<server>__<tool>` is inert unless `<server>` is a
    key of `mcp_servers`. The Linear list said `linear-server` for a server
    registered as `linear`, so no Linear tool was ever approved."""

    def test_the_linear_tools_carry_the_registered_key(self):
        assert all(tool.startswith("mcp__linear__") for tool in LINEAR_TOOLS)

    @pytest.mark.parametrize("agent_type", ["coder", "planner", "qa_reviewer"])
    def test_create_client(self, agent_type, tmp_path, monkeypatch):
        from core.client import create_client

        # Linear on, so the optional server joins the build phases.
        monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
        monkeypatch.setattr("core.client.is_linear_enabled", lambda: True)
        options = _capture_options(
            monkeypatch,
            lambda: create_client(tmp_path, tmp_path, "claude-sonnet-4-5", agent_type),
        )
        servers = set(options["mcp_servers"])
        assert "linear" in servers
        orphans = sorted(
            tool
            for tool in options["allowed_tools"]
            if tool.startswith("mcp__") and tool.split("__")[1] not in servers
        )
        assert not orphans, orphans


class TestTheMigratedCallersNameTheirType:
    def test_the_linear_updater(self, tmp_path, monkeypatch):
        from integrations.linear import updater

        monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("core.auth.require_auth_token", lambda *a, **k: "t")
        monkeypatch.setattr(
            "core.auth.ensure_claude_code_oauth_token", lambda *a, **k: None
        )
        options = _capture_options(monkeypatch, updater._create_linear_client)
        assert set(options["mcp_servers"]) == {"linear"}
        assert set(options["allowed_tools"]) == set(LINEAR_TOOLS)
        assert set(options["disallowed_tools"]) == set(GUARDED_TOOLS)
        assert options["max_turns"] == 10

    def test_the_code_playground(self, tmp_path, monkeypatch):
        from runners.code_playground_runner import CodePlaygroundRunner

        runner = CodePlaygroundRunner(
            str(tmp_path), "a counter", "html", "iframe", model="sonnet"
        )
        options = _capture_options(
            monkeypatch, lambda: runner._create_claude_client("system")
        )
        # It used to name no tool, which approved none and denied none.
        assert options["allowed_tools"] == []
        assert set(options["disallowed_tools"]) == set(GUARDED_TOOLS)
        assert options["max_turns"] == 5
        assert options["cwd"] == str(tmp_path.resolve())

    def test_the_follow_up_planner_plans_like_the_first_planning(
        self, tmp_path, monkeypatch
    ):
        from agents import planner

        calls: list[dict] = []
        monkeypatch.setattr(
            planner, "create_agent_client", lambda **kw: calls.append(kw)
        )
        planner._create_planning_client(tmp_path, tmp_path, "sonnet")
        assert calls and calls[0]["agent_type"] == "planner"
        assert calls[0]["project_dir"] == tmp_path
        assert calls[0]["spec_dir"] == tmp_path
        # No task metadata: the factory resolves the provider, as for coder.py.
        assert calls[0]["provider"] is None
