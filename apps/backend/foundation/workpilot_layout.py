"""
One name per feature under ``<project>/.workpilot/``.

Features grew their own folders, and some grew two: ``learning`` and
``learning_loop``, ``quality`` and ``quality-rules.yml``. Each feature now has
one name, and what an older version left under the other one is **moved** on
first use — never deleted, never written over:

=====================================  =======================================
Before                                 Now
=====================================  =======================================
``learning_loop/patterns.json``        the shared brain, the old file kept as
                                       ``learning/patterns.json.migrated-to-brain``
``quality-rules.yml`` / ``.yaml``      ``quality/rules.yml`` / ``.yaml``
=====================================  =======================================
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["move_aside", "move_legacy"]


def move_legacy(old: Path, new: Path) -> Path | None:
    """Move *old* to *new* if *new* does not exist yet. Returns where it is now.

    When both exist, *old* stays where it is — a person decides which one is
    right — and *new* is the one read. ``None`` when *old* does not exist.
    """
    if not old.exists():
        return None
    if new.exists():
        logger.warning(
            "%s and %s both exist; %s is the one read, the other is left alone",
            old,
            new,
            new,
        )
        return old
    new.parent.mkdir(parents=True, exist_ok=True)
    old.rename(new)
    _remove_if_empty(old.parent)
    logger.info("moved %s to %s", old, new)
    return new


def move_aside(old: Path, folder: Path, suffix: str) -> Path:
    """Move *old* into *folder* as ``<name><suffix>``, numbering past a taken name."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{old.name}{suffix}"
    n = 1
    while target.exists():
        n += 1
        target = folder / f"{old.name}{suffix}.{n}"
    old.rename(target)
    _remove_if_empty(old.parent)
    return target


def _remove_if_empty(folder: Path) -> None:
    try:
        folder.rmdir()
    except OSError:
        pass  # not empty, or not ours to remove: leave it
