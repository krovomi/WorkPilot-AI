"""`SOUL.md` — the persona hermes reads, and how this repository offers one.

Where it actually goes
----------------------
`SOUL.md` is **not** a project file. `agent/prompt_builder.load_soul_md` reads
exactly one path — ``<HERMES_HOME>/SOUL.md`` — and injects it as identity slot
#1 of every session, on every surface hermes runs (CLI, gateway, cron, desktop).
Project context is a different chain entirely: ``.hermes.md`` / ``HERMES.md``,
then ``AGENTS.md``, then ``CLAUDE.md``, then ``.cursorrules`` — first one found
wins, and this repository is already answered by its committed `AGENTS.md`.

So a `SOUL.md` committed at the root of a project is read by nothing. Shipping
one anyway is still the right move, for the reason hermes itself ships one at
the root of its own repository: it is the persona a person installs, and a
persona nobody can see is a persona nobody adopts. The file is the offer; the
install is a separate, explicit act.

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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .home import hermes_home

logger = logging.getLogger(__name__)

__all__ = ["SoulStatus", "repo_soul_path", "soul_status", "install_soul"]

_REPO_ROOT = Path(__file__).resolve().parents[3]


def repo_soul_path(repo_root: Path | None = None) -> Path:
    """The persona this repository offers."""
    return (Path(repo_root) if repo_root else _REPO_ROOT) / "SOUL.md"


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
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            backup = status.installed_path.with_name(f"SOUL.{stamp}.bak.md")
            backup.write_text(_read(status.installed_path) + "\n", encoding="utf-8")
        status.installed_path.write_text(body + "\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("could not install SOUL.md: %s", exc)
        return False, "could not write SOUL.md into the hermes home"
    return True, "installed"
