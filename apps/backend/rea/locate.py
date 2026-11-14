"""How this machine runs the pinned REA release, or why it cannot.

Two ways, both started as ``[node, <script>, …]`` so that no shell and no
``.cmd`` launcher is involved on Windows:

* **installed**: ``rea`` is on PATH and its package is exactly the pinned
  version (``npm install -g rea-agents@<pin>``, which the sidebar badge runs).
  The launcher is resolved to ``rea-agents/scripts/rea.mjs``: through the
  symlink npm writes on macOS and Linux, beside ``rea.cmd`` on Windows.
* **npx**: npm's ``npx-cli.js`` next to the Node.js binary fetches the pinned
  release. That is a download, so a project under strict offline mode
  (``airgapStrict``) refuses it.

Node.js must meet the pin's ranges (REA's own ``engines``); an older one is
reported, never worked around.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import find_executable

from .pin import Pin, load_pin, node_satisfies, parse_version

__all__ = [
    "ReaLauncher",
    "ReaUnavailable",
    "installed_entry",
    "locate",
    "node_version",
    "npx_cli",
]

_VERSION_TIMEOUT = 15


@dataclass(frozen=True)
class ReaLauncher:
    """The argv prefix that runs the pinned REA; the command follows it."""

    argv: tuple[str, ...]
    source: str
    """``installed`` or ``npx``."""
    node_version: str
    version: str

    @property
    def downloads(self) -> bool:
        return self.source == "npx"


@dataclass(frozen=True)
class ReaUnavailable:
    reason: str
    """``node_missing``, ``node_too_old``, ``npx_missing`` or ``offline``."""
    detail: str


def node_version(node: str) -> str | None:
    try:
        result = subprocess.run(
            [node, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=_VERSION_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    version = parse_version(result.stdout)
    return ".".join(str(part) for part in version) if version else None


def _package_version(package_dir: Path) -> str | None:
    try:
        data = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("name") != "rea-agents":
        return None
    version = data.get("version")
    return version if isinstance(version, str) else None


def installed_entry(launcher: str, pin: Pin) -> Path | None:
    """REA's ``scripts/rea.mjs`` behind the ``rea`` found on PATH, at the pinned version.

    npm links ``bin/rea`` to ``lib/node_modules/rea-agents/scripts/rea.mjs`` on
    macOS and Linux and writes ``rea.cmd`` beside ``node_modules/`` on Windows.
    A launcher that leads anywhere else, or to another version, is not used.
    """
    path = Path(launcher)
    candidates = [path.resolve()]
    candidates.append(
        path.parent / "node_modules" / "rea-agents" / "scripts" / "rea.mjs"
    )
    for entry in candidates:
        if entry.name != "rea.mjs" or not entry.is_file():
            continue
        package_dir = entry.parent.parent
        if _package_version(package_dir) == pin.version:
            return entry
    return None


def npx_cli(node: str) -> Path | None:
    """npm's npx entry point next to ``node`` (Windows layout, then POSIX)."""
    base = Path(node).resolve().parent
    for candidate in (
        base / "node_modules" / "npm" / "bin" / "npx-cli.js",
        base.parent / "lib" / "node_modules" / "npm" / "bin" / "npx-cli.js",
    ):
        if candidate.is_file():
            return candidate
    return None


def locate(
    pin: Pin | None = None,
    *,
    allow_download: bool = True,
    node: str | None = None,
    rea: str | None = None,
) -> ReaLauncher | ReaUnavailable:
    """The way to run ``pin`` here. ``node`` and ``rea`` override the PATH lookup (tests)."""
    pin = pin or load_pin()
    node = node or find_executable("node")
    if not node:
        return ReaUnavailable("node_missing", "Node.js is not on PATH")
    version = node_version(node)
    if version is None:
        return ReaUnavailable("node_missing", f"{node} did not report a version")
    if not node_satisfies(version, pin.node):
        return ReaUnavailable(
            "node_too_old",
            f"{pin.spec} needs Node.js {' || '.join(pin.node)}; found {version}",
        )

    launcher = rea if rea is not None else find_executable("rea")
    if launcher:
        entry = installed_entry(launcher, pin)
        if entry is not None:
            return ReaLauncher(
                argv=(node, os.fspath(entry)),
                source="installed",
                node_version=version,
                version=pin.version,
            )

    if not allow_download:
        return ReaUnavailable(
            "offline",
            f"{pin.spec} is not installed and strict offline mode forbids fetching it",
        )
    npx = npx_cli(node)
    if npx is None:
        return ReaUnavailable("npx_missing", f"npx-cli.js not found next to {node}")
    return ReaLauncher(
        argv=(node, os.fspath(npx), "--yes", pin.spec),
        source="npx",
        node_version=version,
        version=pin.version,
    )
