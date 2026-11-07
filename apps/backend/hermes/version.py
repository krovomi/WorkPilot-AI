"""Which hermes-agent is installed, and whether it is recent enough for WorkPilot.

WorkPilot wires features hermes only gained in v0.23.0 ("The Hearth Release",
5 November 2026):

* the progress of a long MCP call (``notifications/progress``) is relayed to
  the person, which is what makes the board's ``wait_for_card`` readable from
  hermes rather than a silent hour;
* ``hermes sessions refresh-prompts`` asks running sessions to rebuild their
  prompt, which is how an installed ``SOUL.md`` reaches a gateway that is
  already up;
* ``hermes curator lock`` keeps a skill a person reviewed from being rewritten
  by hermes's own curator.

An older hermes still runs the learning loop — none of this is a blocker — but
each of those three silently does nothing, so the doctor says which version is
installed and that ``hermes update`` brings the rest.

Why a subprocess, and why it is bounded
---------------------------------------
Every other condition the doctor reads is a file. The version is not: hermes
resolves it from an install stamp *or* live git *or* nothing
(`hermes_cli.version_info`), and its package metadata says ``0.0.0`` on every
source install. ``hermes --version`` is the one answer hermes itself stands
behind, and it has a fast path that skips the import wall. So it is run, with
a timeout, once per binary (keyed by path and modification time — an update
rewrites the file), and only when a caller asks for it: the status a person
opens, never the observe phase at the end of a build.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "MIN_VERSION",
    "UPDATE_COMMAND",
    "installed_version",
    "parse_version",
    "satisfies",
]

#: The release whose features WorkPilot wires (see the module docstring).
MIN_VERSION = "0.23.0"

#: hermes's own updater: it knows whether the install is git, pip, nix or the
#: desktop app, which a command written here could not.
UPDATE_COMMAND = "hermes update"

_TIMEOUT_S = 10.0

# ``Hermes Agent v0.23.0 (2026.9.24)`` or ``Hermes Agent v0.23.0+12.gabc1234``:
# the base release is what decides which features exist. Anchored on the
# product name on purpose: the same output has a ``Python: 3.12.3`` line, and
# a source checkout without its tags prints ``vgit.<sha>`` — no release at all,
# which must read as "unknown", never as Python's version.
_VERSION_RE = re.compile(
    r"hermes agent v(\d{1,3})\.(\d{1,4})\.(\d{1,4})\b", re.IGNORECASE
)

_cache: dict[tuple[str, int], str | None] = {}


def parse_version(text: str) -> str | None:
    """The release ``hermes --version`` names, or None."""
    match = _VERSION_RE.search(text or "")
    return ".".join(match.groups()) if match else None


def _key(version: str) -> tuple[int, int, int]:
    major, minor, patch = (int(part) for part in version.split("."))
    return major, minor, patch


def satisfies(version: str | None, minimum: str = MIN_VERSION) -> bool | None:
    """Whether *version* is at least *minimum*; None when it is unknown."""
    if not version:
        return None
    try:
        return _key(version) >= _key(minimum)
    except ValueError:
        return None


def installed_version(binary: str | None) -> str | None:
    """``hermes --version``'s release, or None. Never raises, never hangs."""
    if not binary:
        return None
    try:
        path = Path(binary).resolve()
        stamp = path.stat().st_mtime_ns
    except OSError:
        return None
    key = (str(path), stamp)
    if key in _cache:
        return _cache[key]
    env = dict(os.environ)
    # The update check behind ``--version`` is cached six hours by hermes and
    # passive; switching colour off keeps the line parseable.
    env.setdefault("NO_COLOR", "1")
    try:
        result = subprocess.run(
            [str(path), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            env=env,
            check=False,
        )
        version = parse_version(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("could not read the hermes version from %s: %s", path, exc)
        version = None
    if version is not None:
        # A miss is not cached: a cold first start can outlast the timeout,
        # and the next panel opened should get to ask again.
        _cache[key] = version
    return version
