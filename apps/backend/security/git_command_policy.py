"""What a model-written Git command may run.

The natural-language Git runner asks a model for one Git command and runs it.
The model reads the repository's status (file names it does not control), so
its answer is treated as untrusted: it runs only when it is a known Git
subcommand, without global options, without an option that makes Git start
another program or write outside the repository, and, for the commands that
talk to a remote, only towards a remote the repository already has.

The command is split like a shell would split it, then run as an argument
list, never through a shell.
"""

from __future__ import annotations

import shlex
from collections.abc import Iterable

# The subcommands the runner may run. Anything else (config, alias, submodule,
# difftool, grep, rebase, bisect, filter-branch, worktree, clone, …) is refused.
ALLOWED_SUBCOMMANDS = frozenset(
    {
        "add",
        "blame",
        "branch",
        "checkout",
        "cherry-pick",
        "commit",
        "describe",
        "diff",
        "fetch",
        "log",
        "merge",
        "mv",
        "pull",
        "push",
        "reflog",
        "remote",
        "reset",
        "restore",
        "revert",
        "rm",
        "shortlog",
        "show",
        "stash",
        "status",
        "switch",
        "tag",
    }
)

# Long options that start a program or write a file of Git's choosing. Git
# accepts any unambiguous abbreviation of a long option, so a prefix of one of
# these is refused too.
_REFUSED_LONG_OPTIONS = (
    "--exec",
    "--upload-pack",
    "--receive-pack",
    "--repo",
    "--output",
    "--strategy",
    "--open-files-in-pager",
)

# Short options refused for one subcommand only (`-s` signs off a commit but
# picks a merge strategy, which Git looks up as a program).
_REFUSED_SHORT_OPTIONS = {
    "merge": ("-s",),
    "pull": ("-s",),
    "cherry-pick": ("-s",),
    "revert": ("-s",),
}

# The subcommands whose first argument is a repository.
_REMOTE_SUBCOMMANDS = frozenset({"fetch", "pull", "push"})

# `git remote` lists the remotes; adding or changing one is refused.
_REMOTE_LISTING = frozenset({"-v", "--verbose"})


class GitCommandRefused(ValueError):
    """The command is not one the runner runs."""


def _refused_long(option: str) -> bool:
    name = option.split("=", 1)[0]
    return len(name) > 2 and any(r.startswith(name) for r in _REFUSED_LONG_OPTIONS)


def _refused_short(subcommand: str, option: str) -> bool:
    return any(
        option.startswith(short) for short in _REFUSED_SHORT_OPTIONS.get(subcommand, ())
    )


def git_argv(command: str, remotes: Iterable[str]) -> list[str]:
    """The argument list to run for ``command``, or ``GitCommandRefused``."""
    try:
        parts = shlex.split(command)
    except ValueError as error:
        raise GitCommandRefused(f"cannot read the command: {error}") from None
    if len(parts) < 2 or parts[0] != "git":
        raise GitCommandRefused("not a git command")
    subcommand, args = parts[1], parts[2:]
    if subcommand not in ALLOWED_SUBCOMMANDS:
        raise GitCommandRefused(f"git {subcommand} is not allowed here")

    positional: list[str] = []
    options_done = False
    for arg in args:
        if options_done or not arg.startswith("-") or arg == "-":
            positional.append(arg)
        elif arg == "--":
            options_done = True
        elif arg.startswith("--") and _refused_long(arg):
            raise GitCommandRefused(f"the option {arg} is not allowed here")
        elif not arg.startswith("--") and _refused_short(subcommand, arg):
            raise GitCommandRefused(f"the option {arg} is not allowed here")

    if subcommand == "remote" and not set(args) <= _REMOTE_LISTING:
        raise GitCommandRefused("git remote may only list the remotes")
    if subcommand in _REMOTE_SUBCOMMANDS and positional:
        if positional[0] not in set(remotes):
            raise GitCommandRefused(
                f"{positional[0]} is not a remote of this repository"
            )
    return parts
