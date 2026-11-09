"""`SOUL.md` — the persona hermes reads, and how this repository offers one.

Where it actually goes
----------------------
`SOUL.md` is **not** a project file. `agent/prompt_builder.load_soul_md` reads
exactly one path — ``<HERMES_HOME>/SOUL.md`` — and injects it as identity slot
#1 of every session, on every surface hermes runs (CLI, gateway, cron, desktop).
Project context is a different chain entirely: ``.hermes.md`` / ``HERMES.md``,
then ``AGENTS.md``, then ``CLAUDE.md``, then ``.cursorrules`` — first one found
wins, and this repository is already answered by its committed `AGENTS.md`.

So a `SOUL.md` committed at the root of a project is read by nothing. The
persona WorkPilot offers therefore lives beside this module
(``apps/backend/hermes/SOUL.md``), not at the root of the repository: it is
data of this package, it ships with the backend wherever the backend goes (the
packaged app, the server image), and the root is left to files that agents do
read. The file is the offer; the install is a separate, explicit act.

Why it is never written automatically
-------------------------------------
``<HERMES_HOME>/SOUL.md`` is the user's own agent identity, shared by every
hermes session on the machine — their Telegram bot, their cron jobs, their
terminal. A build pipeline that silently overwrote it would be rewriting the
personality of an assistant that is not ours, in conversations we will never
see. So `install` is only ever reached from a button someone presses or a flag
someone types, it refuses to clobber a different existing persona unless asked,
and it keeps a timestamped backup when it does.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .home import hermes_home
from .version import MIN_VERSION, installed_version, satisfies

logger = logging.getLogger(__name__)

__all__ = [
    "REFRESH_COMMAND",
    "SOUL_RELATIVE_PATH",
    "SoulStatus",
    "install_soul",
    "refresh_prompts",
    "repo_soul_path",
    "soul_status",
]

#: What makes a running hermes pick up a new persona (hermes >= 0.23.0).
REFRESH_COMMAND = "hermes sessions refresh-prompts"

_REFRESH_TIMEOUT_S = 20.0

#: Where the offered persona sits inside a WorkPilot checkout.
SOUL_RELATIVE_PATH = Path("apps") / "backend" / "hermes" / "SOUL.md"

#: The persona shipped with this backend, beside this module.
_BUNDLED_SOUL = Path(__file__).resolve().with_name("SOUL.md")


def repo_soul_path(repo_root: Path | None = None) -> Path:
    """The persona WorkPilot offers.

    The one in ``repo_root`` when that checkout has one, else the one shipped
    beside this module. The fallback is what makes the packaged app work: there
    the backend sits under ``resources/backend`` and ``parents[3]`` of this file
    is the install directory, which holds no checkout at all.
    """
    if repo_root:
        candidate = Path(repo_root) / SOUL_RELATIVE_PATH
        if candidate.is_file():
            return candidate
    return _BUNDLED_SOUL


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError as exc:
        logger.debug("could not read %s: %s", path, exc)
        return ""


@dataclass(frozen=True)
class SoulStatus:
    """What is offered here, and what is installed there."""

    repo_path: Path
    installed_path: Path
    offered: bool
    """The repository ships a persona."""
    installed: bool
    """`<HERMES_HOME>/SOUL.md` exists and is not empty."""
    matches: bool
    """The installed persona is byte-for-byte the one offered here."""

    @property
    def state(self) -> str:
        if not self.offered:
            return "unavailable"
        if not self.installed:
            return "not-installed"
        return "installed" if self.matches else "diverged"

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "offered": self.offered,
            "installed": self.installed,
            "matches": self.matches,
            "installedPath": str(self.installed_path),
            # The repository path is ours and safe to name; the install path is
            # the user's own home, which they already know — neither leaks a
            # path the caller did not supply or already own.
            "repoPath": str(self.repo_path),
        }


def soul_status(repo_root: Path | None = None, home: Path | None = None) -> SoulStatus:
    """Compare the offered persona with the installed one. Reads only."""
    repo_path = repo_soul_path(repo_root)
    installed_path = (home or hermes_home()) / "SOUL.md"
    offered = _read(repo_path)
    installed = _read(installed_path)
    return SoulStatus(
        repo_path=repo_path,
        installed_path=installed_path,
        offered=bool(offered),
        installed=bool(installed),
        matches=bool(offered) and offered == installed,
    )


def install_soul(
    repo_root: Path | None = None,
    home: Path | None = None,
    *,
    overwrite: bool = False,
) -> tuple[bool, str]:
    """Copy this repository's persona into ``<HERMES_HOME>/SOUL.md``.

    Returns ``(changed, message)``. Never raises: a failure here is a message
    in a panel, not an exception through an endpoint.

    A *different* persona already in place is left alone unless ``overwrite``,
    and even then the old one is kept beside it with a timestamp. Overwriting
    someone's agent identity with no way back is not a thing a button should be
    able to do by accident.
    """
    status = soul_status(repo_root, home)
    if not status.offered:
        return False, "this repository ships no SOUL.md"
    if status.matches:
        return False, "already installed and identical"
    if status.installed and not overwrite:
        return False, (
            "a different SOUL.md is already installed; "
            "re-run with overwrite to replace it (the current one is backed up)"
        )

    body = _read(status.repo_path)
    try:
        status.installed_path.parent.mkdir(parents=True, exist_ok=True)
        if status.installed:
            stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
            backup = status.installed_path.with_name(f"SOUL.{stamp}.bak.md")
            backup.write_text(_read(status.installed_path) + "\n", encoding="utf-8")
        status.installed_path.write_text(body + "\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("could not install SOUL.md: %s", exc)
        return False, "could not write SOUL.md into the hermes home"
    return True, "installed"


def refresh_prompts(home: Path | None = None) -> str:
    """Ask hermes's continuing sessions to rebuild their prompt from SOUL.md.

    A persona copied into the hermes home is read when a session builds its
    system prompt — and a session that is already running (the Telegram bot,
    the gateway every client attaches to since hermes 0.23) built it long ago.
    Before 0.23 the only way to get the new persona in was to restart them.
    ``hermes sessions refresh-prompts`` records a refresh request in the
    profile's own state: each continuing session rebuilds once, on its next
    turn, history kept. It is called right after the install a person asked
    for, because a persona that only applies to sessions not yet started is
    not what they pressed the button for.

    Returns ``requested``, ``needs-update`` (hermes older than the command),
    or ``unavailable`` (no binary, or the command failed). Never raises.
    """
    binary = shutil.which("hermes")
    if not binary:
        return "unavailable"
    if satisfies(installed_version(binary), MIN_VERSION) is False:
        return "needs-update"
    env = dict(os.environ)
    if home is not None:
        # The same home the persona was written into, not whichever profile
        # the variable of this process happens to name.
        env["HERMES_HOME"] = str(home)
    try:
        result = subprocess.run(
            [binary, *REFRESH_COMMAND.split()[1:], "--json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_REFRESH_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            env=env,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.info("hermes sessions refresh-prompts did not run: %s", exc)
        return "unavailable"
    if result.returncode != 0:
        logger.info("hermes sessions refresh-prompts exited %s", result.returncode)
        return "unavailable"
    return "requested"
