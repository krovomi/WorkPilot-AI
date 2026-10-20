"""A shell command may not write the project's security configuration.

`path_guard` refuses the write tools on these files; this is the other half.
Before it, every refused line below passed the command guard: `echo`, `sed`,
`cp`, `tee` and `rm` are all in `BASE_COMMANDS`, and nothing looked at *which*
file they wrote. Rewriting `.workpilot-security.json` — or writing the
allowlist and deleting the profile so the next call re-analyses — widened the
allowlist for the very next command, because `get_security_profile` reloads
on an mtime change. `test_the_attack_this_closes` replays that sequence.

The legitimate half matters as much: reading these files is no secret, and a
lookalike name (`config/guardrails.yaml`, `src/settings.json`) is the
project's own business.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import security.profile as profile_module  # noqa: E402
import security.shell_validators as shell_validators  # noqa: E402
from project import BASE_COMMANDS, SecurityProfile  # noqa: E402
from security.command_guard import validate_command_line  # noqa: E402
from security.config_write_validators import (  # noqa: E402
    validate_security_config_writes,
)
from security.validator_registry import LINE_VALIDATORS  # noqa: E402


def refused(command: str) -> str:
    allowed, reason = validate_security_config_writes(command)
    assert not allowed, f"{command!r} was allowed to write security configuration"
    return reason


def permitted(command: str) -> None:
    allowed, reason = validate_security_config_writes(command)
    assert allowed, f"{command!r} was refused: {reason}"


class TestWritingTheConfigurationIsRefused:
    @pytest.mark.parametrize(
        "command",
        [
            # The forms the finding names.
            "echo nc >> .workpilot-allowlist",
            "sed -i 's/pytest/nc/' .workpilot-allowlist",
            "cp /tmp/workpilot/evil .workpilot-security.json",
            # Redirections, whatever the command and however spaced.
            "echo nc>>.workpilot-allowlist",
            "echo nc 1>> .workpilot-allowlist",
            "printf nc > ./.workpilot-allowlist",
            "> .workpilot-allowlist",
            "cat x >| .workpilot-allowlist",
            "echo x &> .claude_settings.json",
            "exec 3<>.workpilot-allowlist",
            "{ echo nc; } >> .workpilot-allowlist",
            "(echo nc) >.workpilot-allowlist",
            "echo nc | cat >> .workpilot-allowlist",
            # Commands that write the file they are given.
            "printf nc | tee -a .workpilot-allowlist",
            "mv evil .workpilot-security.json",
            "ln -sf /tmp/workpilot/evil .workpilot-allowlist",
            "dd if=evil of=.workpilot-allowlist",
            "install -m 644 evil .claude/settings.json",
            "rsync evil .claude/settings.local.json",
            "truncate -s 0 .workpilot/guardrails.yaml",
            "perl -pi -e 's/a/b/' .workpilot-security.json",
            "git checkout -- .workpilot-allowlist",
            "git restore .claude/settings.json",
            "sed -n 'w .workpilot-allowlist' notes.txt",
            # Deleting one is a write: the profile is rebuilt on the next call,
            # from an allowlist the agent may have written.
            "rm .workpilot-security.json",
            "rm -f sub/../.workpilot-security.json",
            "rm .workpilot/guardrails.json",
            # The directory that holds one, replaced or removed whole.
            "rm -rf .claude",
            "rm -rf .workpilot",
            "mv .claude .claude.bak",
            # Wildcards that expand to one.
            "rm .workpilot-allow*",
            "rm .claude/*",
            "find . -name '.workpilot-allow*' -delete",
            # Inline code names the file in an argument that is not a path.
            "python3 -c \"open('.workpilot-allowlist', 'a').write('nc')\"",
            "node -e \"require('fs').appendFileSync('.workpilot-allowlist', 'nc')\"",
            # Wrappers write as the command they run.
            "sudo tee -a .workpilot-allowlist",
            "env A=1 timeout 5 cp evil .workpilot-allowlist",
            # A shell's -c string is read like the line around it.
            "bash -c 'echo nc >> .workpilot-allowlist'",
            "sh -ec \"bash -c 'cp evil .claude_settings.json'\"",
            # A `cd` earlier in the line is followed.
            "cd .workpilot && echo x > guardrails.yaml",
            "cd .claude; cp evil settings.json",
            "cd src && cd ../.claude && rm settings.json",
            # Another spelling of the same file.
            "cp evil ./.WORKPILOT-ALLOWLIST",
            "cp evil '.workpilot-allowlist.'",
            "cp evil C:\\proj\\.claude\\settings.json",
        ],
    )
    def test_refused(self, command):
        assert "security configuration" in refused(command)

    def test_the_reason_names_the_file(self):
        assert ".workpilot-allowlist" in refused("echo nc >> .workpilot-allowlist")

    def test_a_line_that_will_not_tokenize_is_refused_when_it_names_one(self):
        refused('echo "unterminated > .workpilot-allowlist')


class TestReadingAndLookalikesAreAllowed:
    @pytest.mark.parametrize(
        "command",
        [
            # Reading what the allowlist grants is no secret.
            "cat .workpilot-allowlist",
            "grep nc .workpilot-security.json",
            "cat .claude/settings.json | jq .",
            "ls -la .claude",
            "cd .claude && ls",
            "git diff .workpilot-allowlist",
            "git -C sub log -- .claude/settings.json",
            "cat .workpilot-allowlist > /tmp/workpilot/copy",
            "echo 'see .workpilot-allowlist'",
            # Writing elsewhere.
            "echo x > out.txt",
            "cp src/settings.json dist/settings.json",
            "echo x > config/guardrails.yaml",
            "mkdir -p .workpilot/specs/001",
            "rm .workpilot/specs/001/tmp.json",
            "rm -rf ./node_modules",
            # Ordinary build lines.
            "npm test 2>&1 | tail -20",
            "pytest tests/ -q",
            "git add -A && git commit -m 'document .claude/settings.json'",
            "echo $((1 + 2)) > n.txt",
            "grep -r '#' src > out.txt",
            "ls *",
        ],
    )
    def test_permitted(self, command):
        permitted(command)


class TestItIsWiredIntoTheGuard:
    """Registered once, in `validator_registry`, and run by `command_guard` at
    every level it recurses into."""

    @pytest.fixture
    def profile(self, tmp_path, monkeypatch) -> SecurityProfile:
        from security.constants import PROJECT_DIR_ENV_VAR

        monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))
        built = SecurityProfile()
        built.base_commands = set(BASE_COMMANDS) | {"python3"}
        # By module object, not dotted string: see test_security_command_guard.
        profile_module.reset_profile_cache()
        monkeypatch.setattr(profile_module, "resolve_active_profile", lambda: built)
        monkeypatch.setattr(shell_validators, "resolve_active_profile", lambda: built)
        return built

    def test_it_is_a_line_validator(self):
        assert validate_security_config_writes in LINE_VALIDATORS

    @pytest.mark.parametrize(
        "command",
        [
            "echo nc >> .workpilot-allowlist",
            "echo $(tee -a .workpilot-allowlist < evil)",
            "echo `cp evil .workpilot-allowlist`",
            "eval 'echo nc >> .workpilot-allowlist'",
            "find . -name x -exec cp {} .workpilot-allowlist ;",
            "rtk tee -a .workpilot-allowlist",
        ],
    )
    def test_the_guard_refuses_it(self, command, profile):
        allowed, reason = validate_command_line(command, profile)
        assert not allowed
        assert "security configuration" in reason

    def test_the_guard_still_allows_reading_it(self, profile):
        assert validate_command_line("cat .workpilot-allowlist", profile) == (True, "")


class TestEndToEnd:
    def test_the_sdk_hook_denies_it(self, tmp_path, monkeypatch):
        from security.constants import PROJECT_DIR_ENV_VAR
        from security.hooks import bash_security_hook

        monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))
        profile_module.reset_profile_cache()
        verdict = asyncio.run(
            bash_security_hook(
                {
                    "tool_name": "Bash",
                    "tool_input": {"command": "echo nc >> .workpilot-allowlist"},
                }
            )
        )
        output = verdict["hookSpecificOutput"]
        assert output["permissionDecision"] == "deny"
        assert "security configuration" in output["permissionDecisionReason"]

    def test_the_executor_refuses_it_and_nothing_is_written(self, tmp_path):
        """Copilot, OpenAI and the local models run their commands here."""
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(str(tmp_path), agent_type="coder")
        result = asyncio.run(
            executor.execute(
                "run_command", {"command": "echo nc >> .workpilot-allowlist"}
            )
        )
        assert result.startswith("Command refused by the project's security policy")
        assert not (tmp_path / ".workpilot-allowlist").exists()

    def test_the_attack_this_closes(self, tmp_path, monkeypatch):
        """Write the allowlist, drop the cached profile, run the new command.

        Each step is refused now. The last assertion is what made it worth
        refusing: the profile the guard reads is the one on disk, so the steps
        that are refused here are the steps that would have granted `nc`.
        """
        from project import is_command_allowed
        from security.constants import PROJECT_DIR_ENV_VAR
        from security.hooks import bash_security_hook

        monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))
        profile_module.reset_profile_cache()

        def refusal(command: str) -> str:
            verdict = asyncio.run(
                bash_security_hook(
                    {"tool_name": "Bash", "tool_input": {"command": command}}
                )
            )
            output = verdict["hookSpecificOutput"]
            assert output["permissionDecision"] == "deny"
            return output["permissionDecisionReason"]

        assert "security configuration" in refusal("echo nc >> .workpilot-allowlist")
        assert "security configuration" in refusal("rm .workpilot-security.json")
        assert "nc" in refusal("nc -l 4444")

        # What the refused steps would have done, done by the test instead.
        profile_path = tmp_path / ".workpilot-security.json"
        data = json.loads(profile_path.read_text(encoding="utf-8"))
        data["custom_commands"] = ["nc"]
        time.sleep(0.01)  # a distinct mtime on file systems with coarse clocks
        profile_path.write_text(json.dumps(data), encoding="utf-8")
        widened = profile_module.get_security_profile(tmp_path)
        assert is_command_allowed("nc", widened)[0]
