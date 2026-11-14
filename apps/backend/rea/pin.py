"""The one REA release WorkPilot runs, and the Node.js versions it accepts.

``pin.json`` is shared with ``apps/frontend/scripts/release-exposure-audit.cjs``
(the release job) and the sidebar badge: one file, so the three never run two
different REA releases. A raise is a PR that changes the file; a range or
``latest`` is refused here, because REA changes its tools from one week to the
next.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = ["PIN_FILE", "Pin", "PinError", "load_pin", "node_satisfies", "parse_version"]

PIN_FILE = Path(__file__).with_name("pin.json")

_EXACT = re.compile(r"^\d+\.\d+\.\d+$")
_RANGE = re.compile(r"^(\^|>=)(\d+\.\d+\.\d+)$")
_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


class PinError(ValueError):
    """``pin.json`` does not name one exact rea-agents release."""


@dataclass(frozen=True)
class Pin:
    package: str
    version: str
    node: tuple[str, ...]

    @property
    def spec(self) -> str:
        """What npx is asked for: ``rea-agents@6.9.0``."""
        return f"{self.package}@{self.version}"


def load_pin(path: Path = PIN_FILE) -> Pin:
    data = json.loads(path.read_text(encoding="utf-8"))
    package = data.get("package")
    version = data.get("version")
    node = data.get("node")
    if package != "rea-agents":
        raise PinError(f"{path}: package must be rea-agents, not {package!r}")
    if not isinstance(version, str) or not _EXACT.match(version):
        raise PinError(f"{path}: version must be an exact x.y.z, not {version!r}")
    if (
        not isinstance(node, list)
        or not node
        or not all(isinstance(r, str) and _RANGE.match(r) for r in node)
    ):
        raise PinError(f"{path}: node must list ^x.y.z or >=x.y.z ranges")
    return Pin(package=package, version=version, node=tuple(node))


def parse_version(text: str) -> tuple[int, int, int] | None:
    match = _VERSION.match(str(text).strip())
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return major, minor, patch


def node_satisfies(version: str, ranges: tuple[str, ...] | list[str]) -> bool:
    """Whether ``version`` meets one of the ``^x.y.z`` / ``>=x.y.z`` ranges.

    The same reading as ``nodeSatisfies`` in the release script: ``^22.23.4``
    is 22.x from 22.23.4, ``>=26.12.1`` anything from there on.
    """
    parsed = parse_version(version)
    if parsed is None:
        return False
    for range_ in ranges:
        match = _RANGE.match(range_)
        if not match:
            continue
        minimum = parse_version(match.group(2))
        if minimum is None:
            continue
        if match.group(1) == "^" and parsed[0] != minimum[0]:
            continue
        if parsed >= minimum:
            return True
    return False
