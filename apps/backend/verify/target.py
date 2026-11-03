"""One thing to launch, and the file helpers every detector shares.

Its own module so that `verify.detect` and `verify.web_stacks` both build on
it without importing each other.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

__all__ = ["SKIP_DIRS", "Target"]

#: Directories never searched for an app: dependencies, build output, VCS.
SKIP_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".workpilot",
    ".worktrees",
    "vendor",
    "Pods",
}


@dataclass
class Target:
    """One thing to launch."""

    kind: str
    name: str
    #: The directory it runs from, relative to the project ("." for the root).
    root: str = "."
    framework: str = ""
    #: The command line, with ``{port}`` where a port goes. Empty for mobile,
    #: whose commands are per platform (`platforms`).
    command: str = ""
    #: The port the app listens on by default; the launch prefers a free one.
    port: int = 0
    #: A path that answers once the app is up ("/" accepts any HTTP status).
    ready_path: str = "/"
    #: Environment variables that carry the port, per framework.
    port_env: list[str] = field(default_factory=list)
    #: Extra environment for the launch (no secrets: names known to the stack).
    env: dict[str, str] = field(default_factory=dict)
    #: For mobile: the platforms this task asks for.
    platforms: list[str] = field(default_factory=list)
    #: A file of the task lives under `root`.
    touched: bool = False
    #: A backend that renders pages (Razor, Blazor Server, Django, Rails…):
    #: opened in the browser as well as called (`verify.web_stacks`).
    pages: bool = False
    #: ``recipe`` when a learned recipe supplied the command, else ``detected``.
    origin: str = "detected"
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _relative(path: Path, project_dir: Path) -> str:
    try:
        rel = path.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return "."
    return rel or "."


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}
