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

Node.js must meet the pin's ranges (REA's own ``engines``). The PATH's Node.js
comes first; when it is missing or too old, the newest release a version
manager already installed that meets them is used instead (``node_installs``):
under WSL the PATH holds nvm's default alias, not the version the user's
terminal switched to. A prerelease counts as its release (``27.0.0-alpha.1``
meets ``>=26.12.1``), as npm reads ``engines``. With no accepted Node.js
anywhere, the PATH's version is reported, never worked around. The ``rea``
on PATH is looked for first, then the one npm put beside the chosen Node.js.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import find_executable, is_windows

from .node_installs import NodeInstall, managed_installs
from .pin import Pin, load_pin, node_satisfies, parse_version

__all__ = [
    "ReaLauncher",
    "ReaUnavailable",
    "installed_entry",
    "locate",
    "node_version",
    "npx_cli",
    "pick_node",
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
    node_manager: str | None = None
    """The version manager that holds the Node.js used, when it is not the PATH's."""

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


def _same_file(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(
            os.path.abspath(b)
        )


def pick_node(
    path_node: str | None,
    pin: Pin,
    installs: Sequence[NodeInstall],
) -> tuple[str, str, str | None] | ReaUnavailable:
    """``(node, version, manager)`` that runs ``pin``, or why there is none.

    The PATH's Node.js when it meets the pin; otherwise the newest managed
    release that does, its version read by running it (a directory name is a
    hint, not a proof). ``manager`` is ``None`` for the PATH's Node.js.
    """
    path_version = node_version(path_node) if path_node else None
    if path_node and path_version and node_satisfies(path_version, pin.node):
        return path_node, path_version, None
    for install in installs:
        dotted = ".".join(str(part) for part in install.version)
        if not node_satisfies(dotted, pin.node):
            continue
        if path_node and _same_file(install.path, path_node):
            continue
        version = node_version(install.path)
        if version and node_satisfies(version, pin.node):
            return install.path, version, install.manager
    if not path_node:
        return ReaUnavailable("node_missing", "Node.js is not on PATH")
    if path_version is None:
        return ReaUnavailable("node_missing", f"{path_node} did not report a version")
    return ReaUnavailable(
        "node_too_old",
        f"{pin.spec} needs Node.js {' || '.join(pin.node)}; found {path_version}",
    )


def _beside_node(node: str) -> str:
    """The ``rea`` launcher npm writes beside ``node`` for a global install."""
    return os.fspath(Path(node).parent / ("rea.cmd" if is_windows() else "rea"))


def locate(
    pin: Pin | None = None,
    *,
    allow_download: bool = True,
    node: str | None = None,
    rea: str | None = None,
    installs: Sequence[NodeInstall] | None = None,
) -> ReaLauncher | ReaUnavailable:
    """The way to run ``pin`` here.

    ``node``, ``rea`` and ``installs`` override the PATH lookup and the
    version managers' directories (tests).
    """
    pin = pin or load_pin()
    path_node = node or find_executable("node")
    chosen = pick_node(
        path_node,
        pin,
        managed_installs() if installs is None else installs,
    )
    if isinstance(chosen, ReaUnavailable):
        return chosen
    node, version, manager = chosen

    launchers = [rea if rea is not None else find_executable("rea")]
    if rea is None:
        launchers.append(_beside_node(node))
    for launcher in launchers:
        if not launcher:
            continue
        entry = installed_entry(launcher, pin)
        if entry is not None:
            return ReaLauncher(
                argv=(node, os.fspath(entry)),
                source="installed",
                node_version=version,
                version=pin.version,
                node_manager=manager,
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
        node_manager=manager,
    )
