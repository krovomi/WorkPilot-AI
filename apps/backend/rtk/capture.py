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


def capture_for_model(
    argv: list[str] | str,
    *,
    cwd: Path | str | None = None,
    timeout: float = 60.0,
    env: dict | None = None,
) -> Capture:
    """Run a command through rtk when it helps, and return what a model should read.

    `argv` may be a list (the normal case — no shell, no quoting surprises) or
    a string for a command that genuinely needs a pipeline. Either way rtk is
    asked about the whole command line, because its table matches on prefixes
    like `uv run pytest` that a single token cannot express.
    """
    as_string = argv if isinstance(argv, str) else shlex.join(argv)

    condensed = False
    command = as_string
    if model_facing_enabled(env):
        outcome = rewrite_command(as_string, env)
        command = outcome.command
        condensed = outcome.changed

    # A list that rtk left alone runs as a list: no shell, no quoting to get
    # wrong. The shell is only used where the command is genuinely a command
    # line — a caller that asked for a pipeline, or rtk's own rewrite, which
    # comes back as text and can carry a prefix such as `uv run`.
    needs_shell = condensed or isinstance(argv, str)
    try:
        proc = subprocess.run(  # noqa: S602 - shell only for a command line; see above
            command if needs_shell else list(argv),
            shell=needs_shell,
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
