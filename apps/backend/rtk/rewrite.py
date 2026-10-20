"""`git status` in, `rtk git status` out — and the rule for when it is not.

The decision of *what* rtk can condense is not reimplemented here. rtk ships
`rtk rewrite <command>`, which is the same table its own shell hooks consult
(`src/discover/registry.rs`), and it answers through its exit code:

    0 + stdout   a rewrite exists                       → use it
    1            rtk has no filter for this command     → leave it alone
    2            a deny rule matched                    → leave it alone
    3 + stdout   a rewrite exists behind an "ask" rule  → use it, do not auto-allow

Reimplementing the table in Python would mean a second answer to "is this
command condensable", drifting from the first on every rtk release — and the
table is a hundred commands deep. One subprocess per Bash tool call is the
price of not owning it, and it is a few milliseconds against a tool call that
is about to run a test suite.

Failing open is the whole contract. rtk absent, too old, timing out, crashing,
printing something unexpected: the command runs exactly as written. The worst
this module can do to a build is cost it 2 seconds.
"""

from __future__ import annotations

import logging
import os
import shlex
import subprocess
from dataclasses import dataclass

from .runtime import is_usable, rtk_binary

logger = logging.getLogger(__name__)

__all__ = [
    "Rewrite",
    "rewrite_command",
    "unwrap_rtk",
]

#: `rtk rewrite` reads a string and answers from a table. Two seconds is far
#: past a table lookup and far short of anything a user would notice; a machine
#: under load that cannot answer in that time gets the command unchanged.
_TIMEOUT = 2.0

_ALLOW = 0
_NO_EQUIVALENT = 1
_DENIED = 2
_ASK = 3


@dataclass(frozen=True)
class Rewrite:
    """What to run, and whether anything changed."""

    command: str
    changed: bool
    #: True when rtk matched an "ask" rule: the rewrite stands, but the caller
    #: must not turn the command into an auto-approval on rtk's word.
    needs_confirmation: bool = False
    #: Why nothing changed, for the one log line a debugging session needs.
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.changed


def _unchanged(command: str, reason: str) -> Rewrite:
    return Rewrite(command=command, changed=False, reason=reason)


def rewrite_command(command: str, env: dict | None = None) -> Rewrite:
    """The command to actually run, condensed by rtk when rtk knows how.

    Never raises. Every failure path returns the command as it came in.
    """
    if not command or not command.strip():
        return _unchanged(command, "empty")
    if not is_usable(env):
        return _unchanged(command, "rtk not usable here")

    binary = rtk_binary()
    if not binary:  # pragma: no cover - is_usable already checked
        return _unchanged(command, "rtk not installed")

    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [binary, "rewrite", command],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        logger.debug("rtk rewrite timed out for: %s", command[:120])
        return _unchanged(command, "timeout")
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("rtk rewrite failed: %s", exc)
        return _unchanged(command, "rtk rewrite failed")

    if proc.returncode == _NO_EQUIVALENT:
        return _unchanged(command, "no rtk equivalent")
    if proc.returncode == _DENIED:
        # rtk's own deny rules. Leaving the command alone is right: the
        # rewrite is a token optimisation, not a permission, and WorkPilot's
        # allowlist is the thing that decides whether this runs at all.
        return _unchanged(command, "rtk deny rule")
    if proc.returncode not in (_ALLOW, _ASK):
        return _unchanged(command, f"rtk rewrite exit {proc.returncode}")

    rewritten = (proc.stdout or "").strip()
    if not rewritten or rewritten == command:
        # Identical output means the command was already going through rtk.
        return _unchanged(command, "already rtk")

    return Rewrite(
        command=rewritten,
        changed=True,
        needs_confirmation=proc.returncode == _ASK,
    )


# ---------------------------------------------------------------------------
# Reading a command that is already wrapped
# ---------------------------------------------------------------------------

#: rtk's own subcommands that are about rtk rather than about a command it is
#: proxying. `rtk gain` runs no program; unwrapping it would have the security
#: layer validate a command named "gain" that does not exist.
#: Mirrors `RTK_META_COMMANDS` in rtk's `src/core/constants.rs`.
_META = frozenset(
    {
        "gain",
        "discover",
        "learn",
        "init",
        "config",
        "recall",
        "run",
        "hook",
        "hook-audit",
        "pipe",
        "cc-economics",
        "verify",
        "trust",
        "untrust",
        "session",
        "rewrite",
        "telemetry",
        "smart",
        "deps",
        "json",
    }
)

#: The two rtk filters whose name is not the name of the program they stand
#: for. Every other one — `rtk git`, `rtk pytest`, `rtk cargo`, `rtk grep` —
#: is spelled like the tool it proxies, so unwrapping produces a name the
#: allowlist already knows.
_ALIASES = {"read": "cat", "lint": "eslint"}


def unwrap_rtk(command: str) -> str:
    """The command rtk would actually execute, for whoever has to judge it.

    This exists for the security layer, and it is not a convenience. rtk falls
    back to raw execution for anything its table does not cover
    (`run_fallback` in rtk's `main.rs`), so `rtk <anything>` runs `<anything>`.
    A validator that read the command name as "rtk" and stopped there would be
    handing the allowlist a single always-approved word behind which any binary
    on the machine could be reached.

    Returns the command unchanged when it is not an rtk invocation, and returns
    ``rtk`` on its own for rtk's meta commands, which proxy nothing.
    """
    if not command:
        return command
    try:
        tokens = shlex.split(command)
    except ValueError:
        return command
    if not tokens:
        return command

    head = os.path.basename(tokens[0].strip("'\"")).lower()
    if head not in ("rtk", "rtk.exe"):
        return command

    rest = tokens[1:]
    # `rtk proxy <cmd>` — run <cmd> unfiltered. The thing to validate is <cmd>.
    if rest and rest[0] == "proxy":
        rest = rest[1:]
    if not rest:
        return "rtk"
    if rest[0] in _META:
        return "rtk"
    # Flags belonging to rtk itself, before the proxied command.
    while rest and rest[0].startswith("-"):
        rest = rest[1:]
    if not rest:
        return "rtk"

    rest[0] = _ALIASES.get(rest[0], rest[0])
    return " ".join(shlex.quote(token) if " " in token else token for token in rest)
