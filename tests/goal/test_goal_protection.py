"""No agent writes the goal: the three barriers that guard the security files guard it too.

A goal an agent could rewrite is a goal it can meet with ``true``.
"""

from __future__ import annotations

import asyncio

import pytest
from goal.spec import GOAL_FILENAME
from security.child_env import env_without_credentials, is_credential_name
from security.config_write_validators import validate_security_config_writes
from security.path_guard import make_write_path_hook, protected_config_target


def test_the_goal_file_is_protected_configuration():
    assert protected_config_target(f".workpilot/specs/001-x/{GOAL_FILENAME}")
    assert protected_config_target(GOAL_FILENAME.upper())
    assert protected_config_target("goal.json") is None


def test_the_write_tools_refuse_it_in_the_spec_directory(tmp_path):
    project, spec = tmp_path / "wt", tmp_path / "spec"
    project.mkdir()
    spec.mkdir()
    hook = make_write_path_hook(project, spec)
    result = asyncio.run(
        hook(
            {
                "tool_name": "Write",
                "tool_input": {"file_path": str(spec / GOAL_FILENAME), "content": "{}"},
            }
        )
    )
    assert result["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.parametrize(
    "command",
    [
        f'echo \'{{"command": "true"}}\' > {GOAL_FILENAME}',
        f"rm .workpilot/specs/001-x/{GOAL_FILENAME}",
        f"sed -i 's/pytest/true/' {GOAL_FILENAME}",
    ],
)
def test_the_shell_cannot_rewrite_it(command):
    allowed, _reason = validate_security_config_writes(command)
    assert not allowed


def test_reading_it_stays_allowed():
    allowed, _reason = validate_security_config_writes(f"cat {GOAL_FILENAME}")
    assert allowed


@pytest.mark.parametrize(
    "name",
    [
        "OPENAI_API_KEY",
        "GH_TOKEN",
        "DB_PASSWORD",
        "AWS_SECRET_ACCESS_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ],
)
def test_credentials_are_recognised(name):
    assert is_credential_name(name)


def test_the_child_environment_keeps_the_rest():
    env = env_without_credentials(
        {"PATH": "/bin", "XAI_API_KEY": "x", "TOKENIZER": "y"}, {"CI": "1"}
    )
    assert env == {"PATH": "/bin", "TOKENIZER": "y", "CI": "1"}
