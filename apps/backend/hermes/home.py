"""Where hermes-agent keeps its state, and what it was told there.

One question, one answer. `learning_loop/hermes_ingest.py` needed the home
directory to read authored skills; the readiness check needs it to know whether
hermes is installed at all; `soul.py` needs it to know whether the persona is
in place. Three modules resolving `~/.hermes` on their own is three chances to
disagree about a user who moved it, so the resolution lives here and the other
three import it.

The order is hermes's own (`hermes_constants.get_hermes_home`), mirrored rather
than guessed: ``HERMES_HOME``, else ``%LOCALAPPDATA%\\hermes`` on Windows, else
``~/.hermes``. A user who set the variable is found; one who did not gets the
platform default their installer used.

Reading the config is deliberately tolerant. ``~/.hermes/config.yaml`` is a file
a person edits by hand, and a syntax error in it is not a reason for a Kanban
panel to fail to open — it is a reason to report "could not read the config",
which is what an unreadable file returns here.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "hermes_home",
    "hermes_config_path",
    "read_config",
    "trusted_project_dirs",
    "is_trusted",
]


def hermes_home() -> Path:
    """Hermes's state directory, following hermes's own resolution order."""
    override = os.environ.get("HERMES_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        return base / "hermes"
    return Path.home() / ".hermes"


def hermes_config_path(home: Path | None = None) -> Path:
    return (home or hermes_home()) / "config.yaml"


def read_config(home: Path | None = None) -> dict[str, Any]:
    """``config.yaml`` as a mapping. ``{}`` when absent, empty or unreadable."""
    path = hermes_config_path(home)
    try:
        if not path.is_file():
            return {}
        import yaml

        loaded = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:  # noqa: BLE001 - a hand-edited file is not an outage
        logger.debug("could not read the hermes config at %s: %s", path, exc)
        return {}
    return loaded if isinstance(loaded, dict) else {}


def trusted_project_dirs(home: Path | None = None) -> list[Path]:
    """The roots listed in ``skills.trusted_project_dirs``, resolved.

    This is hermes's own trust gate, and it is the reason a freshly cloned
    WorkPilot checkout loads none of its 390-odd skills into a hermes session:
    project skills are load-on-demand procedures an agent will follow, so
    auto-sourcing them from any repository on disk is a prompt-injection vector.
    Hermes therefore requires the root to be named here, and nothing in this
    repository can or should write that entry — it is a per-machine decision by
    a person, taken with ``hermes skills trust``.
    """
    skills = read_config(home).get("skills")
    raw = skills.get("trusted_project_dirs") if isinstance(skills, dict) else None
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[Path] = []
    for entry in raw:
        text = str(entry or "").strip()
        if not text:
            continue
        try:
            out.append(Path(text).expanduser().resolve())
        except (OSError, RuntimeError):  # pragma: no cover - malformed entry
            continue
    return out


def is_trusted(project_root: Path, home: Path | None = None) -> bool:
    """Whether *project_root* is a root hermes will load skills from."""
    try:
        root = Path(project_root).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    return any(root == t for t in trusted_project_dirs(home))
