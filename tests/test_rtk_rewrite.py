"""rtk — the protocol, the failure paths, and the one security consequence.

Two kinds of test live here, and the split is deliberate.

Most of them run against a **fake rtk**: a script that answers with a chosen
exit code and stdout. That is honest about what they prove — they prove
WorkPilot reads rtk's exit-code protocol correctly and fails open on every
other outcome. They do not prove anything about rtk.

`test_rtk_contract.py` is the other half, and it runs against whatever rtk the
machine really has.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

import rtk  # noqa: E402
from rtk import hook as rtk_hook  # noqa: E402
from rtk import rewrite as rtk_rewrite  # noqa: E402
from rtk import runtime as rtk_runtime  # noqa: E402


def _fake_rtk(tmp_path: Path, body: str) -> Path:
    """A stand-in binary. `--version` always answers; the rest is the body."""
    script = tmp_path / "rtk"
    script.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "--version" ]; then echo "rtk 0.48.0"; exit 0; fi\n'
        f"{body}\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "RTK_ENABLED",
        "RTK_MODEL_FACING",
        "RTK_DISABLED",
        "WORKPILOT_RTK_PATH",
    ):
        monkeypatch.delenv(key, raising=False)
    rtk_runtime.reset_cache()
    yield
    rtk_runtime.reset_cache()


@pytest.fixture
def installed(tmp_path, monkeypatch):
    """Install a fake rtk that rewrites anything to `rtk <command>`."""

    def _install(body: str) -> Path:
        script = _fake_rtk(tmp_path, body)
        monkeypatch.setenv("WORKPILOT_RTK_PATH", str(script))
        rtk_runtime.reset_cache()
        return script

    return _install


# ---------------------------------------------------------------------------
# The exit-code protocol
# ---------------------------------------------------------------------------


def test_rewrite_applies_when_rtk_has_an_equivalent(installed):
    installed('echo "rtk $2"; exit 0')
    result = rtk_rewrite.rewrite_command("git status")
    assert result.changed
    assert result.command == "rtk git status"
    assert not result.needs_confirmation


def test_ask_rule_rewrites_but_flags_confirmation(installed):
    installed('echo "rtk $2"; exit 3')
    result = rtk_rewrite.rewrite_command("git push")
    assert result.changed
    assert result.needs_confirmation


def test_no_equivalent_leaves_the_command_alone(installed):
    installed("exit 1")
    result = rtk_rewrite.rewrite_command("echo hello")
    assert not result.changed
    assert result.command == "echo hello"


def test_deny_rule_leaves_the_command_alone(installed):
    """rtk's deny rules are not WorkPilot's permission model.

    Refusing here would give a token optimiser a vote on whether a command may
    run, which is `bash_security_hook`'s job and nobody else's.
    """
    installed('echo "rtk $2"; exit 2')
    result = rtk_rewrite.rewrite_command("rm -rf /")
    assert not result.changed
    assert result.command == "rm -rf /"


def test_unexpected_exit_code_fails_open(installed):
    installed('echo "garbage"; exit 42')
    assert not rtk_rewrite.rewrite_command("git status").changed


def test_identical_output_is_not_a_change(installed):
    installed('echo "$2"; exit 0')
    result = rtk_rewrite.rewrite_command("rtk git status")
    assert not result.changed
    assert result.reason == "already rtk"


# ---------------------------------------------------------------------------
# Failing open
# ---------------------------------------------------------------------------


def test_absent_binary_is_a_no_op(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    assert not rtk.is_usable()
    assert rtk_rewrite.rewrite_command("git status").command == "git status"


def test_disabled_by_settings_is_a_no_op(installed, monkeypatch):
    installed('echo "rtk $2"; exit 0')
    monkeypatch.setenv("RTK_ENABLED", "false")
    assert not rtk.is_usable()
    assert not rtk_rewrite.rewrite_command("git status").changed


def test_rtks_own_escape_hatch_is_honoured(installed, monkeypatch):
    installed('echo "rtk $2"; exit 0')
    monkeypatch.setenv("RTK_DISABLED", "1")
    assert not rtk.is_usable()


def test_a_crashing_rtk_never_raises(installed):
    installed("exit 99")
    assert rtk_rewrite.rewrite_command("git status").command == "git status"


def test_an_empty_command_is_left_alone(installed):
    installed('echo "rtk $2"; exit 0')
    assert not rtk_rewrite.rewrite_command("   ").changed


def test_a_binary_that_is_too_old_is_not_used(tmp_path, monkeypatch):
    """`rtk rewrite` landed in 0.23.0; older binaries answer it with a parse error."""
    script = tmp_path / "rtk"
    script.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "--version" ]; then echo "rtk 0.19.0"; exit 0; fi\n'
        "exit 2\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("WORKPILOT_RTK_PATH", str(script))
    rtk_runtime.reset_cache()
    assert rtk_runtime.rtk_version() == (0, 19, 0)
    assert not rtk.is_usable()


def test_an_unreadable_version_is_not_treated_as_too_old(tmp_path, monkeypatch):
    """A cosmetic change to rtk's version line must not turn the feature off."""
    script = tmp_path / "rtk"
    script.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$1" = "--version" ]; then echo "rtk (nightly)"; exit 0; fi\n'
        'echo "rtk $2"; exit 0\n',
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("WORKPILOT_RTK_PATH", str(script))
    rtk_runtime.reset_cache()
    assert rtk_runtime.rtk_version() is None
    assert rtk.is_usable()


# ---------------------------------------------------------------------------
# The hook
# ---------------------------------------------------------------------------


async def test_hook_rewrites_a_bash_command(installed):
    installed('echo "rtk $2"; exit 0')
    out = await rtk_hook.rtk_rewrite_hook(
        {"tool_name": "Bash", "tool_input": {"command": "git status"}}
    )
    assert out["hookSpecificOutput"]["updatedInput"]["command"] == "rtk git status"


async def test_hook_never_decides_permissions(installed):
    """A token optimiser must not be able to approve a tool call.

    WorkPilot already grants `Bash(*)` in its settings file and gates the real
    decision on the security hook and the guardrails. A second hook answering
    "allow" would be a third opinion that only knows about bytes.
    """
    installed('echo "rtk $2"; exit 0')
    out = await rtk_hook.rtk_rewrite_hook(
        {"tool_name": "Bash", "tool_input": {"command": "git status"}}
    )
    assert "permissionDecision" not in out["hookSpecificOutput"]


async def test_hook_preserves_the_rest_of_the_tool_input(installed):
    installed('echo "rtk $2"; exit 0')
    out = await rtk_hook.rtk_rewrite_hook(
        {
            "tool_name": "Bash",
            "tool_input": {
                "command": "git status",
                "timeout": 5000,
                "description": "x",
            },
        }
    )
    updated = out["hookSpecificOutput"]["updatedInput"]
    assert updated["timeout"] == 5000
    assert updated["description"] == "x"


async def test_hook_ignores_other_tools(installed):
    installed('echo "rtk $2"; exit 0')
    assert (
        await rtk_hook.rtk_rewrite_hook(
            {"tool_name": "Read", "tool_input": {"file_path": "x"}}
        )
        == {}
    )


async def test_hook_leaves_malformed_input_to_the_security_hook(installed):
    installed('echo "rtk $2"; exit 0')
    assert (
        await rtk_hook.rtk_rewrite_hook({"tool_name": "Bash", "tool_input": None}) == {}
    )


async def test_hook_is_silent_when_rtk_is_absent(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    assert (
        await rtk_hook.rtk_rewrite_hook(
            {"tool_name": "Bash", "tool_input": {"command": "git status"}}
        )
        == {}
    )


# ---------------------------------------------------------------------------
# The awareness paragraph
# ---------------------------------------------------------------------------


def test_awareness_is_absent_without_rtk(monkeypatch):
    """A model told its output is condensed when it is not will re-run good commands."""
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    assert rtk.awareness_section() == ""


def test_awareness_is_present_with_rtk(installed):
    installed("exit 1")
    section = rtk.awareness_section()
    assert "rtk proxy" in section
    assert "condensed" in section


def test_awareness_carries_nothing_volatile(installed):
    """It sits in the cacheable prompt prefix: no version, no path, no count."""
    installed("exit 1")
    section = rtk.awareness_section()
    assert rtk_runtime.rtk_binary() not in section
    assert "0.48" not in section
    assert section == rtk.awareness_section()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def test_project_env_is_read_from_workpilot_dotenv(tmp_path):
    env_dir = tmp_path / ".workpilot"
    env_dir.mkdir()
    (env_dir / ".env").write_text(
        'RTK_ENABLED=false\nRTK_MODEL_FACING="true"\nOTHER=1\n', encoding="utf-8"
    )
    values = rtk.project_env(tmp_path)
    assert values == {"RTK_ENABLED": "false", "RTK_MODEL_FACING": "true"}


def test_an_exported_variable_wins_over_the_file(tmp_path, monkeypatch):
    env_dir = tmp_path / ".workpilot"
    env_dir.mkdir()
    (env_dir / ".env").write_text("RTK_ENABLED=false\n", encoding="utf-8")
    monkeypatch.setenv("RTK_ENABLED", "true")
    rtk.apply_project_env(tmp_path)
    assert os.environ["RTK_ENABLED"] == "true"


def test_model_facing_follows_the_master_switch(monkeypatch):
    monkeypatch.setenv("RTK_ENABLED", "false")
    monkeypatch.setenv("RTK_MODEL_FACING", "true")
    assert not rtk.model_facing_enabled()
