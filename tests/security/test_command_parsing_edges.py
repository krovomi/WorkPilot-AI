"""The command parser and the security-configuration guard on the lines that
sit at their edges: wrappers with options, git's global options, `popd`,
nested shells, escapes inside substitutions, empty pieces of a line."""

from __future__ import annotations

import shlex

import pytest
from project import BASE_COMMANDS, SecurityProfile
from security import command_guard
from security.config_write_validators import validate_security_config_writes
from security.parser import (
    extract_commands,
    extract_substitutions,
    unwrap_rtk_prefixes,
)


def _nested(command: str, levels: int) -> str:
    for _ in range(levels):
        command = "bash -c " + shlex.quote(command)
    return command


class TestTheParser:
    def test_an_empty_piece_between_operators_is_skipped(self):
        assert extract_commands("C:\\tools\\a.exe &&  && dir") == ["a", "dir"]

    def test_a_lone_quote_yields_no_command_so_the_line_is_refused(self):
        assert extract_commands('"') == []

    def test_an_escaped_backtick_stays_inside_the_substitution(self):
        assert extract_substitutions("echo `a\\`b` x") == ["a\\`b"]

    def test_an_unclosed_backtick_runs_nothing(self):
        # bash refuses the line (unexpected EOF): nothing in it runs.
        assert extract_substitutions("echo `whoami") == []

    def test_an_escaped_parenthesis_does_not_close_the_substitution(self):
        assert extract_substitutions("echo $(printf \\) ; id) z") == ["printf \\) ; id"]

    def test_rtk_is_unwrapped_around_empty_pieces(self):
        assert unwrap_rtk_prefixes("rtk git status; ") == "git status; "
        assert (
            unwrap_rtk_prefixes("rtk git status &&  && rtk ls")
            == "git status &&  && ls"
        )


class TestTheConfigurationGuard:
    @pytest.mark.parametrize(
        "command",
        [
            "timeout -s KILL 5 tee .workpilot-allowlist",
            "stdbuf -o0 tee .workpilot-allowlist",
            "nice -n 5 cp evil .workpilot-security.json",
            "git -C . checkout -- .workpilot-allowlist",
            "git --no-pager checkout .workpilot-allowlist",
            "cd sub && popd && cp evil .workpilot-allowlist",
            # The inner `bash -c` is read as the shell reads it: its script
            # keeps its own quotes, and the `cd` in it is followed.
            "bash -c 'bash -c \"cd .workpilot && echo x > guardrails.yaml\"'",
            # A Windows path: the line is read without POSIX escapes, and the
            # script of `-c` keeps its quotes until they are taken off.
            'bash -c "copy C:\\tmp\\evil .workpilot-allowlist"',
        ],
    )
    def test_a_write_behind_a_wrapper_or_an_option_is_refused(self, command):
        allowed, reason = validate_security_config_writes(command)
        assert not allowed, command
        assert "security configuration" in reason

    @pytest.mark.parametrize(
        "command",
        [
            "git -C . --no-pager log .workpilot-allowlist",
            "git",
            "bash build.sh",
            _nested("ls", 5),
        ],
    )
    def test_reading_and_harmless_lines_pass(self, command):
        assert validate_security_config_writes(command) == (True, "")

    def test_a_shell_nested_too_deep_is_refused_unread(self):
        allowed, reason = validate_security_config_writes(_nested("ls", 6))
        assert not allowed
        assert "nested deeper than 5 levels" in reason


class TestTheCommandGuard:
    def test_a_validator_judges_the_whole_line_when_no_segment_names_it(
        self, monkeypatch
    ):
        profile = SecurityProfile()
        profile.base_commands = set(BASE_COMMANDS)
        judged: list[str] = []

        def validator(segment: str):
            judged.append(segment)
            return False, "refused by the rm validator"

        monkeypatch.setitem(command_guard.VALIDATORS, "rm", validator)
        monkeypatch.setattr(
            command_guard, "get_command_for_validation", lambda cmd, segments: ""
        )

        allowed, reason = command_guard.validate_command_line(
            "rtk rm -rf build", profile
        )

        assert (allowed, reason) == (False, "refused by the rm validator")
        assert judged == ["rm -rf build"]
