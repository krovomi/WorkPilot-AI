"""`bash_security_hook`: the PreToolUse answer for one Bash call."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from security import hooks
from security.constants import PROJECT_DIR_ENV_VAR
from security.hooks import bash_security_hook, validate_command


def _denied(answer):
    out = answer.get("hookSpecificOutput", {})
    return out.get("permissionDecision") == "deny", out.get(
        "permissionDecisionReason", ""
    )


@pytest.fixture
def no_env_project(monkeypatch):
    monkeypatch.delenv(PROJECT_DIR_ENV_VAR, raising=False)


async def test_other_tools_and_empty_commands_pass(no_env_project):
    assert await bash_security_hook({"tool_name": "Read", "tool_input": None}) == {}
    assert (
        await bash_security_hook({"tool_name": "Bash", "tool_input": {"command": ""}})
        == {}
    )


@pytest.mark.parametrize(
    ("tool_input", "reason"),
    [(None, "is None"), (["ls"], "must be dict, got list")],
)
async def test_a_malformed_call_is_denied(no_env_project, tool_input, reason):
    denied, why = _denied(
        await bash_security_hook({"tool_name": "Bash", "tool_input": tool_input})
    )
    assert denied is True
    assert reason in why


async def test_the_project_comes_from_the_env_then_the_call_then_the_context(
    tmp_path, monkeypatch
):
    seen = []

    def profile_for(project_dir):
        seen.append(project_dir)
        return hooks.SecurityProfile()

    monkeypatch.setattr(hooks, "_profile_for", profile_for)
    call = {
        "tool_name": "Bash",
        "tool_input": {"command": "ls"},
        "cwd": str(tmp_path / "call"),
    }

    monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path / "env"))
    await bash_security_hook(call)
    monkeypatch.delenv(PROJECT_DIR_ENV_VAR)
    await bash_security_hook(call)
    await bash_security_hook(
        {**call, "cwd": None}, context=SimpleNamespace(cwd=str(tmp_path / "ctx"))
    )
    monkeypatch.chdir(tmp_path)
    await bash_security_hook({**call, "cwd": None}, context=SimpleNamespace(cwd=None))

    assert [p.name for p in seen] == ["env", "call", "ctx", tmp_path.name]


async def test_a_command_outside_the_allowlist_is_denied(tmp_path, monkeypatch):
    monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))
    denied, why = _denied(
        await bash_security_hook(
            {"tool_name": "Bash", "tool_input": {"command": "curl-evil-binary x"}}
        )
    )
    assert denied is True
    assert "curl-evil-binary" in why
    allowed = await bash_security_hook(
        {"tool_name": "Bash", "tool_input": {"command": "ls -la"}}
    )
    assert allowed == {}


def test_an_unloadable_profile_keeps_only_the_base_commands(
    tmp_path, monkeypatch, capsys
):
    def broken(_project_dir):
        raise RuntimeError("corrupt profile")

    monkeypatch.setattr(hooks, "get_security_profile", broken)

    profile = hooks._profile_for(tmp_path)

    assert profile.base_commands == hooks.BASE_COMMANDS
    assert "Could not load security profile" in capsys.readouterr().out


def test_validate_command_uses_the_current_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert validate_command("ls")[0] is True
    assert validate_command("curl-evil-binary")[0] is False
