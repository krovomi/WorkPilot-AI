"""The project's `useClaudeMd` setting decides whether a session loads CLAUDE.md.

The frontend passes the setting as `USE_CLAUDE_MD`. `create_client` always
gives the SDK the "project" setting source, which is what makes Claude Code
load CLAUDE.md — into the session's user context, so WorkPilot's custom system
prompt never replaced it. The flag only changed a log line: CLAUDE.md loaded
whatever the project said, and the manual fallback re-read the same path the
native check had just found missing, so it could never inject anything.

Off now sets Claude Code's own memory switch in the CLI's environment; the
"project" source stays, because it also carries the project's skills and hooks.
Unset is on: many runners, the FastAPI server and the CLI never receive the
variable, and the setting's default is on, so the frontend sends "false".
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from core.client import DISABLE_CLAUDE_MD_ENV, apply_claude_md_setting

MARKER = "CLAUDE_MD_MARKER_4b1e"

OFF_VALUES = ["false", "FALSE", " false ", "0", "no", "off"]


def _set_flag(monkeypatch, value: str | None) -> None:
    if value is None:
        monkeypatch.delenv("USE_CLAUDE_MD", raising=False)
    else:
        monkeypatch.setenv("USE_CLAUDE_MD", value)


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


def _create_client_options(monkeypatch, project_dir: Path) -> dict:
    # Imported here: another test may have reloaded `core.client`, and the
    # factory must be the one whose module the capture patches.
    from core.client import create_client

    return _captured_options(
        monkeypatch,
        lambda: create_client(project_dir, project_dir, "claude-sonnet-4-5", "coder"),
    )


def _simple_client_options(monkeypatch, project_dir: Path) -> dict:
    from core.simple_client import create_simple_client

    return _captured_options(
        monkeypatch,
        lambda: create_simple_client(
            agent_type="commit_message", model="claude-haiku-4-5", cwd=project_dir
        ),
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "CLAUDE.md").write_text(f"{MARKER}\n", encoding="utf-8")
    return tmp_path


class TestTheSwitch:
    @pytest.mark.parametrize("value", [None, "", "true", "TRUE", "1", "yes"])
    def test_on_leaves_the_environment_alone(self, monkeypatch, value):
        _set_flag(monkeypatch, value)
        env: dict[str, str] = {}

        assert apply_claude_md_setting(env) is True
        assert DISABLE_CLAUDE_MD_ENV not in env

    @pytest.mark.parametrize("value", OFF_VALUES)
    def test_an_explicit_no_turns_it_off(self, monkeypatch, value):
        _set_flag(monkeypatch, value)
        env: dict[str, str] = {}

        assert apply_claude_md_setting(env) is False
        assert env[DISABLE_CLAUDE_MD_ENV] == "1"

    def test_off_overrides_a_value_already_in_the_environment(self, monkeypatch):
        _set_flag(monkeypatch, "false")
        env = {DISABLE_CLAUDE_MD_ENV: ""}

        apply_claude_md_setting(env)

        assert env[DISABLE_CLAUDE_MD_ENV] == "1"


class TestTheSessionFollowsTheSetting:
    @pytest.mark.parametrize("value", ["true", None])
    def test_on_the_cli_loads_claude_md(self, project, monkeypatch, value):
        _set_flag(monkeypatch, value)

        options = _create_client_options(monkeypatch, project)

        assert "project" in options["setting_sources"]
        assert DISABLE_CLAUDE_MD_ENV not in options["env"]

    def test_off_the_cli_loads_no_claude_md(self, project, monkeypatch):
        _set_flag(monkeypatch, "false")

        options = _create_client_options(monkeypatch, project)

        assert options["env"][DISABLE_CLAUDE_MD_ENV] == "1"

    def test_off_keeps_the_project_source_for_skills_and_hooks(
        self, project, monkeypatch
    ):
        _set_flag(monkeypatch, "false")

        options = _create_client_options(monkeypatch, project)

        assert options["setting_sources"] == ["project", "user", "local"]

    @pytest.mark.parametrize("value", ["true", "false"])
    def test_the_system_prompt_never_carries_claude_md(
        self, project, monkeypatch, value
    ):
        """On, Claude Code loads it once; a copy here would be a second one."""
        _set_flag(monkeypatch, value)

        options = _create_client_options(monkeypatch, project)

        assert MARKER not in options["system_prompt"]
        assert "Project Instructions (from CLAUDE.md)" not in options["system_prompt"]


class TestTheSimpleClientFollowsItToo:
    """It passes no `setting_sources`: every source, CLAUDE.md included."""

    @pytest.mark.parametrize("value", ["true", None])
    def test_on_the_cli_loads_claude_md(self, project, monkeypatch, value):
        _set_flag(monkeypatch, value)

        options = _simple_client_options(monkeypatch, project)

        assert DISABLE_CLAUDE_MD_ENV not in options["env"]

    def test_off_the_cli_loads_no_claude_md(self, project, monkeypatch):
        _set_flag(monkeypatch, "false")

        options = _simple_client_options(monkeypatch, project)

        assert options["env"][DISABLE_CLAUDE_MD_ENV] == "1"
