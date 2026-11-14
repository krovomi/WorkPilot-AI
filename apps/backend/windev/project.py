"""Is this a WinDev, WebDev or WinDev Mobile project, and can an agent read it?

The project file (``.wdp``) sits at the root of the project directory, or one
or two levels down in a repository that holds other things. Its format
decides everything: in the text format the agents read and edit the code; in
the native format they read nothing at all, and saying so beats a build that
invents code it never saw.

The product is read from what the files show, never guessed: WebDev pages
(``.wwh``), a generation configuration named for Android or iOS (WinDev
Mobile) or for a Windows or Linux executable (WinDev) in a text project file.
A native project file names nothing, so its product is "windev" unless pages
show otherwise.
"""

from __future__ import annotations

import os
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .files import ELEMENT_KINDS, file_format
from .text_format import parse_text_element

__all__ = ["WinDevProject", "detect_project", "find_project_files"]

_SKIPPED_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "Backup",
        "Bin",
        "Corbeille",
        "Groupware",
        "Lastsave",
        "Sauvegarde",
        "Exe",
        "Gabarits",
        "Templates",
        ".workpilot",
    }
)
_MAX_DEPTH = 2
_MAX_ELEMENTS = 5000
_MOBILE_RE = re.compile(r"\b(android|ios|iphone|ipad)\b", re.IGNORECASE)
_DESKTOP_RE = re.compile(r"windows|ex[ée]cutable|\bexe\b|linux", re.IGNORECASE)
_CONFIG_NAME_RE = re.compile(r"^ {4}name : (?P<name>.+)$", re.MULTILINE)


@dataclass
class WinDevProject:
    """What WorkPilot knows about one WinDev-family project."""

    root: Path
    project_file: Path
    name: str
    products: list[str]
    """``windev``, ``webdev``, ``windev-mobile``: what the files show."""
    project_format: str
    """``text``, ``native`` or ``unknown``: the format of the ``.wdp``."""
    major_version: int | None
    elements: Counter[str] = field(default_factory=Counter)
    """``text`` / ``native`` / ``unknown`` -> number of element files."""
    configurations: list[str] = field(default_factory=list)

    @property
    def readable(self) -> bool:
        """Whether an agent can read the code of at least some elements."""
        return self.elements.get("text", 0) > 0

    @property
    def fully_text(self) -> bool:
        return self.readable and not self.elements.get("native", 0)

    def as_dict(self) -> dict:
        return {
            "root": str(self.root),
            "projectFile": str(self.project_file),
            "name": self.name,
            "products": list(self.products),
            "projectFormat": self.project_format,
            "majorVersion": self.major_version,
            "elements": dict(self.elements),
            "configurations": list(self.configurations),
            "readable": self.readable,
        }


def find_project_files(project_dir: Path | str) -> list[Path]:
    """Every ``.wdp`` at most two levels below ``project_dir``, shallowest first."""
    root = Path(project_dir)
    found: list[Path] = []
    if not root.is_dir():
        return found
    for dirpath, dirnames, files in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        dirnames[:] = (
            sorted(
                d for d in dirnames if d not in _SKIPPED_DIRS and not d.startswith(".")
            )
            if depth < _MAX_DEPTH
            else []
        )
        found.extend(
            Path(dirpath) / f for f in sorted(files) if f.lower().endswith(".wdp")
        )
    return sorted(found, key=lambda p: (len(p.relative_to(root).parts), str(p)))


def _elements(root: Path) -> tuple[Counter[str], bool]:
    """Formats of the element files under ``root``, and whether pages exist."""
    formats: Counter[str] = Counter()
    pages = False
    seen = 0
    for dirpath, dirnames, files in os.walk(root):
        dirnames[:] = [
            d for d in dirnames if d not in _SKIPPED_DIRS and not d.startswith(".")
        ]
        for name in files:
            suffix = os.path.splitext(name)[1].lower()
            if suffix not in ELEMENT_KINDS:
                continue
            pages = pages or suffix == ".wwh"
            formats[file_format(Path(dirpath) / name)] += 1
            seen += 1
            if seen >= _MAX_ELEMENTS:
                return formats, pages
    return formats, pages


def detect_project(project_dir: Path | str | None) -> WinDevProject | None:
    """The WinDev-family project under ``project_dir``, or None.

    Never raises: an unreadable tree is "not a WinDev project".
    """
    if not project_dir:
        return None
    try:
        files = find_project_files(project_dir)
        if not files:
            return None
        project_file = files[0]
        root = project_file.parent
        project_format = file_format(project_file)
        name, major, configurations = project_file.stem, None, []
        if project_format == "text":
            text = project_file.read_text(encoding="utf-8", errors="replace")
            element = parse_text_element(text)
            name = element.name or name
            major = element.major_version
            configurations = [
                m.group("name").strip() for m in _CONFIG_NAME_RE.finditer(text)
            ]
        elements, pages = _elements(root)
    except OSError:
        return None
    products: list[str] = []
    if pages:
        products.append("webdev")
    if any(_MOBILE_RE.search(c) for c in configurations):
        products.append("windev-mobile")
    if not products or any(_DESKTOP_RE.search(c) for c in configurations):
        products.insert(0, "windev")
    return WinDevProject(
        root=root,
        project_file=project_file,
        name=name,
        products=list(dict.fromkeys(products)),
        project_format=project_format,
        major_version=major,
        elements=elements,
        configurations=configurations,
    )
