"""Which settings files each Claude session loads (`setting_sources`).

Every session used to get ["project", "user", "local"] — the person's own
~/.claude CLAUDE.md, skills and hooks — the planner and QA included, and the
simple client passed none, which the SDK reads as every source. The coder keeps
them; every other type, and a type the registry does not know, loads the
project only.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from agents.tools_pkg import AGENT_CONFIGS, setting_sources_for
from agents.tools_pkg.setting_sources import (
    CODER_USER_SETTINGS_ENV,
    DEFAULT_SOURCES,
    OVERRIDE_ENV,
)

ALL = ["project", "user", "local"]
PROJECT = ["project"]

#: The types the review names, which judge or prepare the work.
PROJECT_ONLY_TYPES = [
    "planner",
    "qa_reviewer",
    "qa_fixer",
    "spec_researcher",
    "spec_writer",
    "spec_critic",
    "spec_self_critique",
    "spec_validation",
    "spec_compaction",
    "analyzer",
    "batch_analysis",
    "batch_validation",
    "impact_analyzer",
    "architecture_reviewer",
    "insight_extractor",
    "learning_analyzer",
    "pr_reviewer",
    "commit_message",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(OVERRIDE_ENV, raising=False)
    monkeypatch.delenv(CODER_USER_SETTINGS_ENV, raising=False)


class TestTheDeclaration:
    def test_the_coder_loads_the_users_settings(self):
        assert setting_sources_for("coder") == ALL

    @pytest.mark.parametrize("agent_type", PROJECT_ONLY_TYPES)
    def test_the_other_phases_load_the_project_only(self, agent_type):
        assert agent_type in AGENT_CONFIGS
        assert setting_sources_for(agent_type) == PROJECT

    def test_the_coder_is_the_only_type_with_the_users_settings(self):
        widened = [t for t in AGENT_CONFIGS if setting_sources_for(t) != PROJECT]
        assert widened == ["coder"]

    @pytest.mark.parametrize("agent_type", ["", "a_type_added_tomorrow", "Coder"])
    def test_an_unknown_type_gets_the_safe_default(self, agent_type):
        assert DEFAULT_SOURCES == ("project",)
        assert setting_sources_for(agent_type) == PROJECT

    def test_the_result_is_a_fresh_list(self):
        setting_sources_for("coder").append("user")
        assert setting_sources_for("coder") == ALL
        assert AGENT_CONFIGS["coder"]["setting_sources"] == ALL


class TestTheCoderToggle:
    @pytest.mark.parametrize("value", ["false", "FALSE", " 0 ", "no", "off"])
    def test_off_narrows_the_coder_to_the_project(self, monkeypatch, value):
        monkeypatch.setenv(CODER_USER_SETTINGS_ENV, value)
        assert setting_sources_for("coder") == PROJECT

    @pytest.mark.parametrize("value", ["", "true", "1", "yes", "on", "anything"])
    def test_anything_else_keeps_them(self, monkeypatch, value):
        monkeypatch.setenv(CODER_USER_SETTINGS_ENV, value)
        assert setting_sources_for("coder") == ALL

    def test_on_never_widens_another_type(self, monkeypatch):
        monkeypatch.setenv(CODER_USER_SETTINGS_ENV, "true")
        assert setting_sources_for("qa_reviewer") == PROJECT


class TestTheOverride:
    @pytest.mark.parametrize("agent_type", ["coder", "planner", "qa_reviewer", "x"])
    def test_it_applies_to_every_type(self, monkeypatch, agent_type):
        monkeypatch.setenv(OVERRIDE_ENV, "user,project")
        assert setting_sources_for(agent_type) == ["project", "user"]

    def test_it_beats_the_coder_toggle(self, monkeypatch):
        monkeypatch.setenv(OVERRIDE_ENV, "project,user,local")
        monkeypatch.setenv(CODER_USER_SETTINGS_ENV, "false")
        assert setting_sources_for("coder") == ALL

    @pytest.mark.parametrize("value", ["user", "local,user", " USER , Local "])
    def test_the_project_is_always_kept(self, monkeypatch, value):
        monkeypatch.setenv(OVERRIDE_ENV, value)
        assert setting_sources_for("planner")[0] == "project"

    def test_unknown_names_are_dropped(self, monkeypatch):
        monkeypatch.setenv(OVERRIDE_ENV, "project,managed,../etc")
        assert setting_sources_for("coder") == PROJECT

    @pytest.mark.parametrize("value", ["", "  ", ",,"])
    def test_an_empty_value_is_no_override(self, monkeypatch, value):
        monkeypatch.setenv(OVERRIDE_ENV, value)
        assert setting_sources_for("coder") == ALL
        assert setting_sources_for("planner") == PROJECT


# -- Through the two factories ------------------------------------------------


def _captured_options(monkeypatch, build) -> dict:
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


def _create_client(monkeypatch, project_dir: Path, agent_type: str) -> dict:
    from core.client import create_client

    return _captured_options(
        monkeypatch,
        lambda: create_client(
            project_dir, project_dir, "claude-sonnet-4-5", agent_type
        ),
    )


def _simple_client(monkeypatch, project_dir: Path, agent_type: str) -> dict:
    from core.simple_client import create_simple_client

    return _captured_options(
        monkeypatch,
        lambda: create_simple_client(
            agent_type=agent_type, model="claude-haiku-4-5", cwd=project_dir
        ),
    )


class TestTheFactories:
    @pytest.mark.parametrize(
        ("agent_type", "expected"),
        [("coder", ALL), ("planner", PROJECT), ("qa_reviewer", PROJECT)],
    )
    def test_create_client_follows_the_type(
        self, monkeypatch, tmp_path, agent_type, expected
    ):
        options = _create_client(monkeypatch, tmp_path, agent_type)
        assert options["setting_sources"] == expected

    def test_create_client_follows_the_coder_toggle(self, monkeypatch, tmp_path):
        monkeypatch.setenv(CODER_USER_SETTINGS_ENV, "false")
        options = _create_client(monkeypatch, tmp_path, "coder")
        assert options["setting_sources"] == PROJECT

    @pytest.mark.parametrize(
        "agent_type", ["commit_message", "pr_followup_reviewer", "insight_extractor"]
    )
    def test_the_simple_client_no_longer_loads_every_source(
        self, monkeypatch, tmp_path, agent_type
    ):
        """Left out, the SDK reads it as every source, ~/.claude included."""
        options = _simple_client(monkeypatch, tmp_path, agent_type)
        assert options["setting_sources"] == PROJECT

    def test_the_users_settings_grant_no_undeclared_tool(self, monkeypatch, tmp_path):
        """Loading ~/.claude, whose allow rules may say `Bash(*)`, widens no type."""
        monkeypatch.setenv(OVERRIDE_ENV, "project,user,local")

        options = _create_client(monkeypatch, tmp_path, "pr_reviewer")

        assert options["setting_sources"] == ALL
        assert {"Write", "Edit", "Bash"} <= set(options["disallowed_tools"])
