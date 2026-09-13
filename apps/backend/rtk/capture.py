"""Running a command whose output WorkPilot is about to put in a prompt.

The hook covers what an *agent* runs. This covers the other half: the commands
WorkPilot runs itself and then pastes into a prompt — the `git diff` a
self-review reads, the branch diff a PR reviewer is given, the failing test
output handed to a fixer. Those are model-facing captures, and they are billed
exactly like a tool result.

One rule, and it is the whole design:

    **rtk is for output a model reads, never for output code parses.**

`git diff --numstat` feeds a counter, `git status --porcelain` feeds a parser,
`git rev-parse HEAD` feeds a string comparison. Condensing any of those does
not save tokens — nothing about them is ever sent to a model — and it silently
breaks the caller. So there is no global switch here and `core.git_executable.
run_git` is deliberately left alone: a call site opts in by using this
function, which is a statement that its output is going to a model.

The capture degrades the same way everything else does. No rtk, rtk too old,
rtk turned off: the command runs unchanged and the caller gets the full output
it has always had.
"""

from __future__ import annotations

import logging
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .rewrite import rewrite_command
from .settings import model_facing_enabled

logger = logging.getLogger(__name__)

__all__ = ["Capture", "capture_for_model"]


@dataclass(frozen=True)
class Capture:
    """The output, and the truth about how it was produced."""

    text: str
    returncode: int
    #: The command as it actually ran, rtk prefix included. Worth keeping: a
    #: reviewer looking at a surprising excerpt needs to know whether it was
    #: filtered before deciding the diff is wrong.
    command: str
    condensed: bool
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


#: Anything a shell would interpret. rtk's rewrites are plain command lines —
#: `git diff HEAD` becomes `rtk git diff HEAD` — so one of these characters in
#: a rewrite means the string is not the argv it looks like, and running it
#: would need a shell. The answer is to run the original command instead of
#: reaching for one.
_SHELL_METACHARACTERS = set("|&;<>()$`\\\"'\n*?[#~")


def _as_argv(rewritten: str) -> list[str] | None:
    """rtk's rewrite as an argv list, or None when it cannot be one safely."""
    if any(char in rewritten for char in _SHELL_METACHARACTERS):
        return None
    try:
        tokens = shlex.split(rewritten)
    except ValueError:
        return None
    return tokens or None


def capture_for_model(
    argv: list[str],
    *,
    cwd: Path | str | None = None,
    timeout: float = 60.0,
    env: dict | None = None,
) -> Capture:
    """Run a command through rtk when it helps, and return what a model should read.

    `argv` is a list and there is no string form, because there is no shell
    here. rtk is asked about the whole command line — its table matches on
    prefixes like `uv run pytest` that a single token cannot express — but what
    comes back is split into an argv again and executed directly. A rewrite
    that cannot be split that way is discarded and the original command runs:
    the condensing is worth a few hundred bytes, and it is not worth handing a
    shell a string that a proxy composed.
    """
    command = shlex.join(argv)
    resolved = list(argv)
    condensed = False

    if model_facing_enabled(env):
        outcome = rewrite_command(command, env)
        if outcome.changed:
            rewritten_argv = _as_argv(outcome.command)
            if rewritten_argv is not None:
                resolved = rewritten_argv
                command = outcome.command
                condensed = True
            else:
                logger.debug("rtk rewrite not runnable as argv: %s", outcome.command)

    try:
        proc = subprocess.run(  # noqa: S603 - argv list, no shell
            resolved,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return Capture(
            text="",
            returncode=124,
            command=command,
            condensed=condensed,
            timed_out=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("capture_for_model failed: %s", exc)
        return Capture(text="", returncode=1, command=command, condensed=condensed)

    text = (proc.stdout or "") + (proc.stderr or "")
    return Capture(
        text=text,
        returncode=proc.returncode,
        command=command,
        condensed=condensed,
    )
