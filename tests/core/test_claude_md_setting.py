"""The project's `useClaudeMd` setting decides whether a session loads CLAUDE.md.

The frontend passes the setting as `USE_CLAUDE_MD`. `create_client` always
gives the SDK the "project" setting source, which is what makes Claude Code
load CLAUDE.md — into the session's user context, so WorkPilot's custom system
prompt never replaced it. The flag only changed a log line: CLAUDE.md loaded
whatever the project said, and the manual fallback re-read the same path the
native check had just found missing, so it could never inject anything.

Off now sets Claude Code's own memory switch in the CLI's environment; the
"project" source stays, because it also carries the project's skills and hooks.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from core.client import (
    DISABLE_CLAUDE_MD_ENV,
    apply_claude_md_setting,
    create_client,
)

MARKER = "CLAUDE_MD_MARKER_4b1e"


def _create_client_options(monkeypatch, project_dir: Path) -> dict:
    """Run `create_client` and return the kwargs it gave ClaudeAgentOptions."""
    import core.client as client_module

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
        create_client(project_dir, project_dir, "claude-sonnet-4-5", "coder")
    return captured


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "CLAUDE.md").write_text(f"{MARKER}\n", encoding="utf-8")
    return tmp_path


class TestTheSwitch:
    @pytest.mark.parametrize("value", ["true", "TRUE", "True"])
    def test_on_leaves_the_environment_alone(self, monkeypatch, value):
        monkeypatch.setenv("USE_CLAUDE_MD", value)
        env: dict[str, str] = {}

        assert apply_claude_md_setting(env) is True
        assert DISABLE_CLAUDE_MD_ENV not in env

    @pytest.mark.parametrize("value", [None, "", "false", "0", "no"])
    def test_anything_but_true_turns_it_off(self, monkeypatch, value):
        if value is None:
            monkeypatch.delenv("USE_CLAUDE_MD", raising=False)
        else:
            monkeypatch.setenv("USE_CLAUDE_MD", value)
        env: dict[str, str] = {}

        assert apply_claude_md_setting(env) is False
        assert env[DISABLE_CLAUDE_MD_ENV] == "1"

    def test_off_overrides_a_value_already_in_the_environment(self, monkeypatch):
        monkeypatch.setenv("USE_CLAUDE_MD", "false")
        env = {DISABLE_CLAUDE_MD_ENV: ""}

        apply_claude_md_setting(env)

        assert env[DISABLE_CLAUDE_MD_ENV] == "1"


class TestTheSessionFollowsTheSetting:
    def test_on_the_cli_loads_claude_md(self, project, monkeypatch):
        monkeypatch.setenv("USE_CLAUDE_MD", "true")

        options = _create_client_options(monkeypatch, project)

        assert "project" in options["setting_sources"]
        assert DISABLE_CLAUDE_MD_ENV not in options["env"]

    def test_off_the_cli_loads_no_claude_md(self, project, monkeypatch):
        monkeypatch.setenv("USE_CLAUDE_MD", "false")

        options = _create_client_options(monkeypatch, project)

        assert options["env"][DISABLE_CLAUDE_MD_ENV] == "1"

    def test_unset_the_cli_loads_no_claude_md(self, project, monkeypatch):
        monkeypatch.delenv("USE_CLAUDE_MD", raising=False)

        options = _create_client_options(monkeypatch, project)

        assert options["env"][DISABLE_CLAUDE_MD_ENV] == "1"

    def test_off_keeps_the_project_source_for_skills_and_hooks(
        self, project, monkeypatch
    ):
        monkeypatch.delenv("USE_CLAUDE_MD", raising=False)

        options = _create_client_options(monkeypatch, project)

        assert options["setting_sources"] == ["project", "user", "local"]

    @pytest.mark.parametrize("value", ["true", "false"])
    def test_the_system_prompt_never_carries_claude_md(
        self, project, monkeypatch, value
    ):
        """On, Claude Code loads it once; a copy here would be a second one."""
        monkeypatch.setenv("USE_CLAUDE_MD", value)

        options = _create_client_options(monkeypatch, project)

        assert MARKER not in options["system_prompt"]
        assert "Project Instructions (from CLAUDE.md)" not in options["system_prompt"]
