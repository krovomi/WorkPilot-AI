"""
Git Validators
==============

Validators for git operations:
- Commit with secret scanning
- Config protection (prevent setting test users)
"""

import os
import shlex
from pathlib import Path

from .validation_models import ValidationResult

# =============================================================================
# BLOCKED GIT CONFIG PATTERNS
# =============================================================================

# Git config keys that agents must NOT modify
# These are identity settings that should inherit from the user's global config
#
# NOTE: This validation covers command-line arguments (git config, git -c).
# Environment variables (GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME,
# GIT_COMMITTER_EMAIL) are NOT validated here as they require pre-execution
# environment filtering, which is handled at the sandbox/hook level.
BLOCKED_GIT_CONFIG_KEYS = {
    "user.name",
    "user.email",
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
    # Code-execution vectors via -c: setting these causes git to spawn
    # arbitrary commands on subsequent operations. CVE-2017-1000117 family.
    "core.sshcommand",
    "core.editor",
    "core.pager",
    "core.hookspath",
    "core.fsmonitor",
    "core.gitproxy",
    # `include.path` and `includeif.*.path` cause git to read another
    # gitconfig file, re-introducing all the keys above by indirection.
    "include.path",
}


def _is_blocked_config_key(key: str) -> bool:
    """Return True if `key` (lowercase) is in the blocklist or matches a wildcard rule."""
    if key in BLOCKED_GIT_CONFIG_KEYS:
        return True
    # `includeif.<condition>.path` — wildcard match on prefix and suffix.
    if key.startswith("includeif.") and key.endswith(".path"):
        return True
    return False


def validate_git_config(command_string: str) -> ValidationResult:
    """
    Validate git config commands - block identity changes.

    Agents should not set user.name, user.email, etc. as this:
    1. Breaks commit attribution
    2. Can create fake "Test User" identities
    3. Overrides the user's legitimate git identity

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse git command"  # Fail closed on parse errors

    if not tokens or tokens[0] != "git":
        return True, ""
    # `git -C dir config …` is a config command too.
    index, _repo = _git_invocation(tokens)
    if index is None or tokens[index] != "config":
        return True, ""  # Not a git config command
    args = tokens[index + 1 :]

    # Check for read-only operations first - these are always allowed
    # --get, --get-all, --get-regexp, --list are all read operations
    read_only_flags = {"--get", "--get-all", "--get-regexp", "--list", "-l"}
    if any(token in read_only_flags for token in args):
        return True, ""  # Read operation, allow it

    # The config key: the first operand past the options and their values.
    # git 2.46 also spells it `git config set <key> <value>`.
    operands: list[str] = []
    skip_next = False
    for token in args:
        if skip_next:
            skip_next = False
            continue
        if token.startswith("-"):
            skip_next = token in _CONFIG_VALUE_OPTIONS
            continue
        operands.append(token)
    if operands and operands[0] in _CONFIG_SUBCOMMANDS:
        operands = operands[1:] if operands[0] in ("set", "unset") else []
    config_key = operands[0].lower() if operands else None

    if not config_key:
        return True, ""  # No config key specified (e.g., git config --list)

    # Check if the config key is blocked (exact match or wildcard rule).
    if _is_blocked_config_key(config_key):
        return False, (
            f"BLOCKED: Cannot modify git configuration key '{config_key}'\n\n"
            f"This key is on the blocklist (identity attribution or "
            f"code-execution vector).\n\n"
            f"WHY: Git identity (user.name, user.email) must inherit from the user's "
            f"global git configuration. Code-execution keys (core.editor, core.pager, "
            f"core.sshcommand, include.path, etc.) let arbitrary commands run on "
            f"subsequent git operations.\n\n"
            f"WHAT TO DO: Remove the offending config and commit normally."
        )

    return True, ""


def validate_git_inline_config(tokens: list[str]) -> ValidationResult:
    """
    Check for blocked config keys passed via git -c flag.

    Git allows inline config with: git -c key=value <command>
    This bypasses 'git config' validation, so we must check all git commands
    for -c flags containing blocked identity keys.

    Args:
        tokens: Parsed command tokens

    Returns:
        Tuple of (is_valid, error_message)
    """
    i = 1  # Start after 'git'
    while i < len(tokens):
        token = tokens[i]

        # Check for -c flag (can be "-c key=value" or "-c" "key=value")
        if token == "-c":
            # Next token should be the key=value
            if i + 1 < len(tokens):
                config_pair = tokens[i + 1]
                # Extract the key from key=value
                if "=" in config_pair:
                    config_key = config_pair.split("=", 1)[0].lower()
                    if _is_blocked_config_key(config_key):
                        return False, (
                            f"BLOCKED: Cannot set '{config_key}' via -c flag\n\n"
                            f"You attempted to use '-c {config_pair}'. This key is blocked "
                            f"(identity attribution or code-execution vector).\n\n"
                            f"WHY: Identity keys break commit attribution. "
                            f"core.editor / core.pager / core.sshcommand / include.path "
                            f"let arbitrary commands run on subsequent git operations.\n\n"
                            f"WHAT TO DO: Remove the -c flag and commit normally."
                        )
                i += 2  # Skip -c and its value
                continue
        elif token.startswith("-c"):
            # Handle -ckey=value format (no space)
            config_pair = token[2:]  # Remove "-c" prefix
            if "=" in config_pair:
                config_key = config_pair.split("=", 1)[0].lower()
                if _is_blocked_config_key(config_key):
                    return False, (
                        f"BLOCKED: Cannot set '{config_key}' via -c flag\n\n"
                        f"You attempted to use '{token}'. This key is blocked "
                        f"(identity attribution or code-execution vector).\n\n"
                        f"WHY: Identity keys break commit attribution. "
                        f"core.editor / core.pager / core.sshcommand / include.path "
                        f"let arbitrary commands run on subsequent git operations.\n\n"
                        f"WHAT TO DO: Remove the -c flag and commit normally. "
                        f"The repository will use the correct identity automatically."
                    )

        i += 1

    return True, ""


def validate_git_command(command_string: str) -> ValidationResult:
    """
    Main git validator that checks all git security rules.

    Currently validates:
    - git -c: Block identity changes via inline config on ANY git command
    - git config: Block identity changes
    - git commit: Run secret scanning

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse git command"

    if not tokens or tokens[0] != "git":
        return True, ""

    if len(tokens) < 2:
        return True, ""  # Just "git" with no subcommand

    # Check for blocked -c flags on ANY git command (security bypass prevention)
    is_valid, error_msg = validate_git_inline_config(tokens)
    if not is_valid:
        return is_valid, error_msg

    # Find the actual subcommand past the global options and their values:
    # `git -C /tmp commit` and `git --git-dir=… commit` are commits.
    index, _repo = _git_invocation(tokens)
    subcommand = tokens[index] if index is not None else None

    if not subcommand:
        return True, ""  # No subcommand found

    # Check git config commands
    if subcommand == "config":
        return validate_git_config(command_string)

    # Check git commit commands (secret scanning)
    if subcommand == "commit":
        return validate_git_commit_secrets(command_string)

    return True, ""


def validate_git_commit_secrets(command_string: str) -> ValidationResult:
    """
    Validate git commit commands - run secret scan before allowing commit.

    This provides autonomous feedback to the AI agent if secrets are detected,
    with actionable instructions on how to fix the issue.

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse git command"

    if not tokens or tokens[0] != "git":
        return True, ""

    # Only intercept 'git commit' commands (not git add, git push, etc.),
    # wherever the global options put the subcommand.
    index, repo = _git_invocation(tokens)
    if index is None or tokens[index] != "commit":
        return True, ""

    from .scan_secrets import (
        get_staged_files,
        get_unstaged_files,
        mask_secret,
        scan_files,
    )

    # What the commit will hold: the index as it stands, plus the tracked
    # changes `commit -a` stages on its way, read from the working tree.
    staged = get_staged_files(repo)
    unstaged = (
        [f for f in get_unstaged_files(repo) if f not in staged]
        if _commits_all(tokens[index + 1 :])
        else []
    )
    if not staged and not unstaged:
        return True, ""  # Nothing to commit, allow it

    matches = scan_files(staged, repo, staged=True) + scan_files(unstaged, repo)

    if not matches:
        return True, ""  # No secrets found, allow commit

    # Secrets found! Build detailed feedback for the AI agent
    # Group by file for clearer output
    files_with_secrets: dict[str, list] = {}
    for match in matches:
        if match.file_path not in files_with_secrets:
            files_with_secrets[match.file_path] = []
        files_with_secrets[match.file_path].append(match)

    # Build actionable error message
    error_lines = [
        "SECRETS DETECTED - COMMIT BLOCKED",
        "",
        "The following potential secrets were found in staged files:",
        "",
    ]

    for file_path, file_matches in files_with_secrets.items():
        error_lines.append(f"File: {file_path}")
        for match in file_matches:
            masked = mask_secret(match.matched_text, 12)
            error_lines.append(f"  Line {match.line_number}: {match.pattern_name}")
            error_lines.append(f"    Found: {masked}")
        error_lines.append("")

    error_lines.extend(
        [
            "ACTION REQUIRED:",
            "",
            "1. Move secrets to environment variables:",
            "   - Add the secret value to .env (create if needed)",
            "   - Update the code to use os.environ.get('VAR_NAME') or process.env.VAR_NAME",
            "   - Add the variable name (not value) to .env.example",
            "",
            "2. Example fix:",
            "   BEFORE: api_key = 'sk-abc123...'",
            "   AFTER:  api_key = os.environ.get('API_KEY')",
            "",
            "3. If this is a FALSE POSITIVE (test data, example, mock):",
            "   - Add the file pattern to .secretsignore",
            "   - Example: echo 'tests/fixtures/' >> .secretsignore",
            "",
            "After fixing, stage the changes with 'git add .' and retry the commit.",
        ]
    )

    return False, "\n".join(error_lines)


# `git config` options that take the next token as their value.
_CONFIG_VALUE_OPTIONS = {
    "-f",
    "--file",
    "--blob",
    "--type",
    "--default",
    "--comment",
    "--value",
}
# git 2.46 subcommands of `git config`; only `set` and `unset` name a key to change.
_CONFIG_SUBCOMMANDS = {
    "set",
    "unset",
    "get",
    "list",
    "edit",
    "rename-section",
    "remove-section",
}

# Global options of git(1) that take the next token as their value.
_VALUE_BEARING_GLOBAL_OPTS = {
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--exec-path",
    "--config-env",
    "--list-cmds",
    "--attr-source",
}


def _git_invocation(tokens: list[str]) -> tuple[int | None, Path]:
    """The index of the subcommand in `tokens`, and the folder git works in.

    The folder starts at the project the hooks were given (or the current
    directory), then follows each `-C` (relative to the previous one, as git
    does) and `--work-tree`.
    """
    from .constants import PROJECT_DIR_ENV_VAR

    repo = Path(os.environ.get(PROJECT_DIR_ENV_VAR) or Path.cwd())
    i = 1
    while i < len(tokens):
        token = tokens[i]
        if not token.startswith("-"):
            return i, repo
        name, _, attached = token.partition("=")
        if name in _VALUE_BEARING_GLOBAL_OPTS and "=" not in token:
            value = tokens[i + 1] if i + 1 < len(tokens) else ""
            i += 2
        else:
            value = attached
            i += 1
        if name == "-C" and value:
            repo = repo / value
        elif name == "--work-tree" and value:
            repo = repo / value
    return None, repo


def _commits_all(args: list[str]) -> bool:
    """Whether `git commit` stages every tracked change itself (`-a`, `-am`)."""
    for arg in args:
        if arg == "--":
            return False
        if arg == "--all":
            return True
        if arg.startswith("-") and not arg.startswith("--"):
            # A short cluster: letters until the first one that takes a value.
            for letter in arg[1:]:
                if letter == "a":
                    return True
                if letter in "mFcCtS":
                    break
    return False


# Backwards compatibility alias - the registry uses this name
# Now delegates to the comprehensive validator
validate_git_commit = validate_git_command
