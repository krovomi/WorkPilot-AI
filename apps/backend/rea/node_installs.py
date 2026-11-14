"""Node.js releases a version manager installed but did not put on PATH.

nvm, fnm, Volta, mise and asdf choose a Node.js per shell: the one a terminal
reports is not necessarily the one an app started elsewhere inherits. Under
WSL, nvm's default alias decides what every new shell (and WorkPilot) gets,
while ``nvm use`` in one terminal changes only that terminal. When the PATH's
Node.js is too old for the pinned REA, ``locate`` looks here for a newer one
already on disk instead of reporting a version the user knows they replaced.

``node_installs.json`` lists where each manager keeps its releases. The
sidebar badge reads the same file (``shared/constants/node-installs.json``,
kept equal by ``tests/rea/test_rea_node_installs.py``), so the badge and the
runner pick the same Node.js. Only directories under the user's home or a
manager's own variable are read, and a candidate is run only as
``[node, "--version"]``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import is_windows

from .pin import parse_version

__all__ = ["LAYOUTS_FILE", "NodeInstall", "managed_installs"]

LAYOUTS_FILE = Path(__file__).with_name("node_installs.json")

_MAX_ENTRIES = 64
"""Directories read per manager: a version list, not a tree to walk."""


@dataclass(frozen=True)
class NodeInstall:
    path: str
    version: tuple[int, int, int]
    """From the directory name; ``locate`` checks it by running the binary."""
    manager: str


def _layouts(windows: bool) -> list[dict[str, object]]:
    data = json.loads(LAYOUTS_FILE.read_text(encoding="utf-8"))
    return list(data["windows" if windows else "posix"])


def _roots(
    layout: Mapping[str, object], home: Path, env: Mapping[str, str]
) -> list[Path]:
    roots: list[Path] = []
    variable = layout.get("env")
    override = env.get(variable) if isinstance(variable, str) else None
    if override and os.path.isabs(override):
        roots.append(Path(override))
    homes = layout.get("homes")
    if isinstance(homes, list):
        roots.extend(home / str(relative) for relative in homes)
    return roots


def managed_installs(
    *,
    home: Path | None = None,
    env: Mapping[str, str] | None = None,
    windows: bool | None = None,
) -> list[NodeInstall]:
    """Every Node.js the known managers hold here, newest first."""
    home = home if home is not None else Path.home()
    env = env if env is not None else os.environ
    windows = is_windows() if windows is None else windows
    found: list[NodeInstall] = []
    seen: set[str] = set()
    for layout in _layouts(windows):
        versions = str(layout.get("versions") or "")
        binary_name = str(layout["bin"])
        for root in _roots(layout, home, env):
            base = root / versions if versions else root
            try:
                entries = sorted(base.iterdir())[:_MAX_ENTRIES]
            except OSError:
                continue
            for entry in entries:
                version = parse_version(entry.name)
                if version is None:
                    continue
                binary = entry / binary_name
                key = os.path.normcase(os.fspath(binary))
                if key in seen or not binary.is_file():
                    continue
                seen.add(key)
                found.append(
                    NodeInstall(
                        path=os.fspath(binary),
                        version=version,
                        manager=str(layout["manager"]),
                    )
                )
    found.sort(key=lambda install: install.version, reverse=True)
    return found
