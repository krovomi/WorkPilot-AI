"""Command lines that would write the project's security configuration.

`security.path_guard` refuses a `Write` or an `Edit` on the files that decide
what an agent may do: the command allowlist (`.workpilot-allowlist`), the
security profile (`.workpilot-security.json`), the user's guardrails
(`.workpilot/guardrails.*`) and the SDK's settings (`.claude_settings.json`,
`.claude/settings*.json`). A shell writes files too, and the same change was
one command away: `echo nc >> .workpilot-allowlist`, `sed -i … ` on the
profile, `cp evil .claude/settings.json` — or `rm .workpilot-security.json`,
after which the next command re-analyses the project and reads an allowlist
written a moment earlier. `get_security_profile` reloads on the next mtime
change, so the widened allowlist applied to the very next command.

How a line is judged
--------------------
Each simple command (the pieces between `|`, `&&`, `;`, `(`…) is read once:

* a redirection that writes (`>`, `>>`, `>|`, `&>`, `<>`) to a protected file
  is refused, whatever the command;
* a command that only reads (`cat`, `grep`, `git diff`…) may *name* one —
  what the allowlist grants is no secret;
* any other command that names one, mentions one inside an argument
  (`python -c "open('.workpilot-allowlist', 'a')"`, `dd of=…`), or names the
  directory that holds one (`rm -rf .claude`) is refused.

Refusing by default is the point. The commands that can write a file are an
open list (`cp`, `mv`, `ln`, `install`, `rsync`, `tee`, `truncate`, `sed -i`,
`perl -i`, `git checkout --`, every interpreter…); the commands that only read
are a short one, and a false refusal costs an agent one rephrasing.

`bash -c '…'` is read here, recursively. `$(…)`, backticks, `eval` and
`find -exec` reach this function again through `command_guard`, which recurses
on them. A `cd` earlier in the line is followed, so
`cd .workpilot && echo … > guardrails.yaml` is judged as the path it writes.

What it does not see
--------------------
A name that is not on the command line: a script the agent wrote and then
runs, a name assembled from variables, a patch, an archive, a branch checked
out. A validator reads text, and those write through content it is not shown.
"""

from __future__ import annotations

import re
import shlex

from .parser import (
    _SHELL_KEYWORDS,
    _WRAPPER_POSITIONALS,
    TRANSPARENT_WRAPPERS,
    _contains_windows_path,
    _cross_platform_basename,
)
from .path_guard import PROTECTED_CONFIG_DIRS, PROTECTED_CONFIG_NAMES
from .path_guard import protected_config_target as _protected_target
from .validation_models import ValidationResult

__all__ = ["validate_security_config_writes"]

#: Redirections that open their target for writing. `<>` opens it read-write,
#: and creates it; `>&` followed by a word that is not a descriptor is `&>`.
_WRITE_REDIRECTS = frozenset({">", ">>", ">|", "&>", "&>>", "<>", ">&"})

#: Redirections whose operand is read, or is a heredoc delimiter.
_READ_REDIRECTS = frozenset({"<", "<<", "<<<", "<&"})

#: Operators that end a simple command.
_SEPARATORS = frozenset({"|", "|&", "||", "&&", ";", ";;", "&", "(", ")"})

#: The characters `shlex` groups into operator tokens, and the operators a
#: group splits into, longest first: `)>` is `)` then `>`.
_PUNCTUATION = frozenset("();<>|&")
_OPERATORS = sorted(
    _WRITE_REDIRECTS | _READ_REDIRECTS | _SEPARATORS, key=len, reverse=True
)

#: Commands that read the files they are given and write none of them. Their
#: redirections are still judged.
_READ_ONLY_COMMANDS = frozenset(
    {
        "cat",
        "head",
        "tail",
        "less",
        "more",
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "ls",
        "stat",
        "file",
        "wc",
        "diff",
        "cmp",
        "md5sum",
        "sha1sum",
        "sha256sum",
        "sha512sum",
        "cksum",
        "readlink",
        "realpath",
        "basename",
        "dirname",
        "test",
        "[",
        "echo",
        "printf",
        "jq",
        "cd",
        "pushd",
        "popd",
        "type",
        "which",
    }
)

#: git subcommands that leave every file of the working tree as it is.
_GIT_READ_ONLY = frozenset(
    {"status", "diff", "log", "show", "blame", "ls-files", "check-ignore", "grep"}
    | {"add", "commit"}
)

#: git options that consume the following token.
_GIT_OPTIONS_WITH_VALUE = frozenset({"-C", "-c", "--git-dir", "--work-tree"})

_SHELLS = frozenset({"bash", "sh", "zsh", "dash", "ksh"})

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

#: How deep `bash -c "bash -c '…'"` may nest before the line is refused unread,
#: as `command_guard` bounds `$( $( … ) )`.
_MAX_SHELL_DEPTH = 5


def _literal_prefix(pattern: str) -> str:
    return re.split(r"[*?\[]", pattern, maxsplit=1)[0]


#: Text that names a protected file inside an argument that is not a path —
#: inline code, a `sed` script. Derived from `path_guard`'s tables so the two
#: cannot drift.
_MENTIONS: tuple[str, ...] = tuple(
    name.casefold() for name in PROTECTED_CONFIG_NAMES
) + tuple(
    f"{directory}/{_literal_prefix(pattern)}".casefold()
    for directory, patterns in PROTECTED_CONFIG_DIRS.items()
    for pattern in patterns
)


def _mentioned(text: str) -> str | None:
    folded = re.sub(r"[\\/]+", "/", text.casefold())
    return next((marker for marker in _MENTIONS if marker in folded), None)


def _split_operators(token: str) -> list[str]:
    parts: list[str] = []
    index = 0
    while index < len(token):
        operator = next(
            (op for op in _OPERATORS if token.startswith(op, index)), token[index]
        )
        parts.append(operator)
        index += len(operator)
    return parts


def _tokenize(line: str) -> list[str]:
    """`line` as words and operators. Raises `ValueError` on unbalanced quotes.

    A Windows path is read without escapes, as `security.parser` reads it:
    POSIX quoting turns `C:\\Users\\.claude` into `C:Users.claude`.
    """
    lexer = shlex.shlex(
        line, posix=not _contains_windows_path(line), punctuation_chars=True
    )
    lexer.whitespace_split = True
    # A `#` inside a word is not a comment to the shell, and treating it as one
    # would drop the rest of the line unread.
    lexer.commenters = ""
    tokens: list[str] = []
    for token in lexer:
        if token and set(token) <= _PUNCTUATION:
            tokens.extend(_split_operators(token))
        else:
            tokens.append(token)
    return tokens


def _simple_commands(tokens: list[str]) -> list[list[str]]:
    commands: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token in _SEPARATORS:
            if current:
                commands.append(current)
            current = []
        else:
            current.append(token)
    if current:
        commands.append(current)
    return commands


def _unquote(token: str) -> str:
    return token.strip("'\"`")


def _command_name(token: str) -> str:
    name = _cross_platform_basename(_unquote(token)).casefold()
    return re.sub(r"\.(exe|cmd|bat)$", "", name)


def _head(words: list[str]) -> tuple[str | None, list[str]]:
    """The command a simple command runs, and the arguments it is given.

    Assignments and keywords are stepped over, and so is a transparent wrapper
    with its own options — `sudo tee` writes as `tee` does.
    """
    options: frozenset[str] = frozenset()
    positionals = 0
    in_wrapper = False
    index = 0
    while index < len(words):
        token = words[index]
        if token in _SHELL_KEYWORDS or _ASSIGNMENT.match(token):
            index += 1
            continue
        if in_wrapper:
            if token in options:
                index += 2
                continue
            if token.startswith("-"):
                index += 1
                continue
            if positionals:
                positionals -= 1
                index += 1
                continue
        name = _command_name(token)
        if name in TRANSPARENT_WRAPPERS:
            options = TRANSPARENT_WRAPPERS[name]
            positionals = _WRAPPER_POSITIONALS.get(name, 0)
            in_wrapper = True
            index += 1
            continue
        return name, words[index + 1 :]
    return None, []


def _git_subcommand(arguments: list[str]) -> str | None:
    index = 0
    while index < len(arguments):
        token = arguments[index]
        if token in _GIT_OPTIONS_WITH_VALUE:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        return token
    return None


def _only_reads(name: str, arguments: list[str]) -> bool:
    if name in _READ_ONLY_COMMANDS:
        return True
    return name == "git" and _git_subcommand(arguments) in _GIT_READ_ONLY


def _shell_inline_command(arguments: list[str]) -> str | None:
    """The `-c` string of `bash -c '…'`, `sh -ec '…'`, or ``None``."""
    for index, token in enumerate(arguments[:-1]):
        if token == "-c" or (
            token.startswith("-") and not token.startswith("--") and "c" in token[1:]
        ):
            return _unquote(arguments[index + 1])
    return None


def _under(cwd: str, path: str) -> str:
    """`path` as seen from the directory an earlier `cd` moved to."""
    if not cwd or re.match(r"^([\\/~$]|[A-Za-z]:)", path):
        return path
    return f"{cwd}/{path}"


def _named_target(path: str, cwd: str) -> str | None:
    return _protected_target(_under(cwd, _unquote(path)), glob=True)


def _argument_target(token: str, cwd: str) -> str | None:
    """The protected file an argument names or mentions, or ``None``."""
    candidates = [token]
    if "=" in token:
        candidates.append(token.split("=", 1)[1])  # `of=…`, `--output=…`
    if token.startswith("-") and not token.startswith("--") and len(token) > 2:
        candidates.append(token[2:])  # `-o.workpilot-allowlist`
    for candidate in candidates:
        target = _protected_target(
            _under(cwd, _unquote(candidate)), glob=True, directories=True
        )
        if target is not None:
            return target
    return _mentioned(token)


def _next_cwd(cwd: str, name: str, arguments: list[str]) -> str:
    """Where `cd`/`pushd`/`popd` leave the line. ``""`` is "not known"."""
    if name == "popd":
        return ""
    operands = [a for a in arguments if not a.startswith("-")]
    if not operands or operands[0].startswith(("~", "$")):
        return ""
    return _under(cwd, _unquote(operands[0]))


def _refusal(target: str) -> ValidationResult:
    return (
        False,
        f"This command writes {target}, the project's security configuration: "
        "it decides which commands and writes this build's agents are "
        "allowed, and an agent does not change its own rights. If the task "
        "needs a command or a permission it does not have, say so in your "
        "output and leave the change to the user.",
    )


def _judge(line: str, depth: int) -> ValidationResult:
    if depth > _MAX_SHELL_DEPTH:
        return False, (
            f"Shell -c nested deeper than {_MAX_SHELL_DEPTH} levels — refused unread."
        )

    try:
        tokens = _tokenize(line)
    except ValueError:
        # A line that will not tokenize is not one to guess at; it is refused
        # only when it could be about one of these files at all.
        if (target := _mentioned(line)) is not None:
            return _refusal(target)
        return True, ""

    cwd = ""
    for command in _simple_commands(tokens):
        words: list[str] = []
        index = 0
        while index < len(command):
            token = command[index]
            if token in _WRITE_REDIRECTS or token in _READ_REDIRECTS:
                operand = command[index + 1] if index + 1 < len(command) else ""
                if token in _WRITE_REDIRECTS and operand:
                    if (target := _named_target(operand, cwd)) is not None:
                        return _refusal(target)
                index += 2
                continue
            words.append(token)
            index += 1

        name, arguments = _head(words)
        if name is None:
            continue

        if name in _SHELLS and (inline := _shell_inline_command(arguments)):
            allowed, reason = _judge(inline, depth + 1)
            if not allowed:
                return allowed, reason
            continue

        if not _only_reads(name, arguments):
            for argument in arguments:
                if (target := _argument_target(argument, cwd)) is not None:
                    return _refusal(target)

        if name in ("cd", "pushd", "popd"):
            cwd = _next_cwd(cwd, name, arguments)

    return True, ""


def validate_security_config_writes(command_string: str) -> ValidationResult:
    """Refuse a command line that writes the project's security configuration.

    A line validator: `command_guard` hands it every line it judges, whatever
    command the line runs, because a redirection writes through a command
    (`echo`, `printf`) that has no validator of its own.
    """
    return _judge(command_string, depth=0)
