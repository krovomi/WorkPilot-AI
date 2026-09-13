"""Where the rtk binary is, whether it can be used here, and what is missing.

rtk (Rust Token Killer, https://github.com/rtk-ai/rtk) is a CLI proxy: it runs
the command you asked for and prints a condensed version of its output. The
exit code and the behaviour are the command's own; only what the model reads
changes. That is the whole reason it is worth wiring in — the single largest
input WorkPilot pays for is not its prompts, it is the output of the commands
its agents run.

Nothing here is allowed to fail a build. rtk is an optional binary on the
machine: not installed, too old, turned off — every path answers "no" in
milliseconds and the caller runs exactly what it would have run before.

The answers are cached for the life of the process. A binary does not appear
mid-build, and `shutil.which` on every Bash tool call is a PATH walk per
command for a value that changes when somebody runs an installer.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .settings import is_enabled

logger = logging.getLogger(__name__)

__all__ = [
    "MIN_VERSION",
    "Check",
    "Report",
    "doctor",
    "is_usable",
    "reset_cache",
    "rtk_binary",
    "rtk_version",
]

#: `rtk rewrite` — the single source of truth for what gets rewritten — landed
#: in 0.23.0. An older binary answers the subcommand with a clap error, which
#: exits non-zero and would read to us as "no rewrite for this command": silent
#: failure rather than a wrong one, but silent failure is what the version gate
#: exists to turn into a sentence.
MIN_VERSION = (0, 23, 0)

_PATH_OVERRIDE = "WORKPILOT_RTK_PATH"

#: rtk's own escape hatch, honoured by the binary itself. When a user has set
#: it, the hook stays out of the way rather than rewriting into a no-op.
_RTK_DISABLED = "RTK_DISABLED"

_CALL_TIMEOUT = 5.0


@lru_cache(maxsize=1)
def rtk_binary() -> str | None:
    """The rtk executable, or None when the machine does not have one.

    `WORKPILOT_RTK_PATH` points at a specific binary — for a build of rtk that
    is not on PATH, and for tests, which need a path that is theirs rather than
    whatever the machine running the suite happens to have installed.
    """
    override = os.environ.get(_PATH_OVERRIDE, "").strip()
    if override:
        path = Path(override).expanduser()
        return str(path) if path.is_file() and os.access(path, os.X_OK) else None
    return shutil.which("rtk")


@lru_cache(maxsize=1)
def rtk_version() -> tuple[int, int, int] | None:
    """The installed version as a tuple, or None if it cannot be read.

    An unreadable version is not treated as too old: rtk prints `rtk 0.41.2` on
    one line today, and a future release that decorates that line should not
    silently turn the integration off. Refusing on a parse failure would make
    every upstream cosmetic change a regression here.
    """
    binary = rtk_binary()
    if not binary:
        return None
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=_CALL_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("rtk --version failed: %s", exc)
        return None
    raw = (proc.stdout or proc.stderr or "").strip()
    for token in raw.replace("rtk", " ").split():
        parts = token.split(".")
        if len(parts) < 2:
            continue
        try:
            numbers = [int(part) for part in parts[:3]]
        except ValueError:
            continue
        while len(numbers) < 3:
            numbers.append(0)
        return (numbers[0], numbers[1], numbers[2])
    return None


def is_usable(env: dict | None = None) -> bool:
    """Whether a command may be routed through rtk in this process.

    Four conditions, cheapest first: the user has not turned it off, rtk's own
    `RTK_DISABLED` is unset, the binary exists, and it is new enough to have
    `rtk rewrite`.
    """
    source = os.environ if env is None else env
    if not is_enabled(source):
        return False
    if str(source.get(_RTK_DISABLED, "")).strip() not in ("", "0", "false"):
        return False
    if not rtk_binary():
        return False
    version = rtk_version()
    return version is None or version >= MIN_VERSION


def reset_cache() -> None:
    """Forget the cached binary and version. For tests, and for the doctor."""
    rtk_binary.cache_clear()
    rtk_version.cache_clear()


# ---------------------------------------------------------------------------
# The doctor
# ---------------------------------------------------------------------------


@dataclass
class Check:
    """One condition, whether it holds, and what to type when it does not."""

    name: str
    ok: bool
    detail: str = ""
    remedy: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "remedy": self.remedy,
        }


@dataclass
class Report:
    """What this machine can do with rtk, answered from files and one exec."""

    installed: bool
    enabled: bool
    version: str = ""
    binary: str = ""
    checks: list[Check] = field(default_factory=list)

    @property
    def state(self) -> str:
        if not self.installed:
            return "absent"
        if not self.enabled:
            return "disabled"
        return "active" if all(check.ok for check in self.checks) else "degraded"

    def to_dict(self) -> dict:
        return {
            "installed": self.installed,
            "enabled": self.enabled,
            "version": self.version,
            "binary": self.binary,
            "state": self.state,
            "checks": [check.to_dict() for check in self.checks],
        }


def _terminal_hook_installed() -> bool:
    """Whether `rtk init -g` has wired rtk into the user's Claude Code settings.

    This is *not* the hook WorkPilot installs. The agents it runs itself are
    covered in-process by ``rtk.hook`` and need nothing on disk; what this asks
    about is the other half — the Claude Code sessions a person opens in
    WorkPilot's own terminals, which read the machine's settings and not ours.
    Reporting it as a separate condition is the difference between "rtk is not
    working" and "rtk is working where WorkPilot drives, and not where you do".
    """
    settings = Path.home() / ".claude" / "settings.json"
    try:
        return "rtk" in settings.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def doctor(env: dict | None = None) -> Report:
    """Every condition, with its remedy. No network, no model, no build.

    Cheap enough for a panel to ask on every open: one `which`, one
    `rtk --version` (both cached), and one small file read.
    """
    source = os.environ if env is None else env
    binary = rtk_binary()
    version = rtk_version()
    enabled = is_enabled(source)

    checks = [
        Check(
            name="install",
            ok=bool(binary),
            detail=binary or "rtk is not on PATH",
            remedy="brew install rtk  ·  https://github.com/rtk-ai/rtk#installation",
        ),
        Check(
            name="version",
            ok=bool(binary) and (version is None or version >= MIN_VERSION),
            detail=".".join(str(part) for part in version) if version else "unknown",
            remedy=f"rtk >= {'.'.join(str(p) for p in MIN_VERSION)} is needed for `rtk rewrite`",
        ),
        Check(
            name="enabled",
            ok=enabled,
            detail="RTK_ENABLED=false" if not enabled else "on",
            remedy="set RTK_ENABLED=true in .workpilot/.env",
        ),
        Check(
            name="terminal-hook",
            ok=_terminal_hook_installed(),
            detail="the machine's own Claude Code sessions are not rewritten",
            remedy="rtk init -g",
        ),
    ]

    return Report(
        installed=bool(binary),
        enabled=enabled,
        version=".".join(str(part) for part in version) if version else "",
        binary=binary or "",
        checks=checks,
    )
