"""The people who settle a project's memory conflicts when they flip-flop.

The issue's escalation: two teammates who keep overturning each other's
decision on the same pair of notes should not keep doing so — after a
decision, the same pair contradicting again within
``BRAIN_CONFLICT_COOLDOWN_DAYS`` (7) is escalated (`arbitration`), and an
escalated pair is settled by a designated maintainer.

The list lives in the vault, so the whole team sees the same one:

    knowledge/projects/<project>/memory/.lifecycle/maintainers.md

    - Alice Martin
    - bob@example.com

A line names a person by their git name or e-mail (`identity.person`). No
list means anyone settles an escalated pair. Changing it is journalled
(``designate``): a team rule, visible to everyone, not an access control.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from ..notes import inside
from .journal import LIFECYCLE_DIR, JournalEntry, append

logger = logging.getLogger(__name__)

__all__ = ["MAX_MAINTAINERS", "allows", "clean", "read", "write"]

MAX_MAINTAINERS = 20
_MAX_NAME = 120
_FILE = "maintainers.md"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_HEADER = "# Mainteneurs de la mémoire\n\n"


def _path(root: Path, base: Path | str) -> Path:
    return inside(root, Path(base) / LIFECYCLE_DIR / _FILE)


def clean(names: list[str]) -> list[str] | None:
    """The names as stored, or ``None`` when one is not a name."""
    out: list[str] = []
    for raw in names:
        name = str(raw).strip()
        if not name or len(name) > _MAX_NAME or _CONTROL.search(name):
            return None
        if name.casefold() not in {n.casefold() for n in out}:
            out.append(name)
    return out if len(out) <= MAX_MAINTAINERS else None


def read(root: Path, base: Path | str) -> list[str]:
    """The maintainers of the memory at *base*; lines a hand edit broke are skipped."""
    try:
        text = _path(root, base).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return []
    names = [
        name
        for line in text.splitlines()
        if line.startswith("- ")
        and (name := line[2:].strip())
        and len(name) <= _MAX_NAME
        and not _CONTROL.search(name)
    ]
    return clean(names[:MAX_MAINTAINERS]) or []


def write(
    root: Path, base: Path | str, names: list[str], *, actor: str = "user"
) -> list[str] | None:
    """Replace the list. ``None`` when a name is refused (nothing is written)."""
    kept = clean(names)
    if kept is None:
        return None
    target = _path(root, base)
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = "".join(f"- {name}\n" for name in kept)
    target.write_text(_HEADER + lines, encoding="utf-8", newline="\n")
    append(
        root,
        base,
        JournalEntry(
            action="designate",
            actor=actor,
            note=(Path(base) / LIFECYCLE_DIR / _FILE).as_posix(),
            title="maintainers",
            reason_code="maintainers-changed",
            reason=", ".join(kept),
        ),
    )
    return kept


def allows(names: list[str], who: dict[str, str]) -> bool:
    """Whether *who* settles an escalated pair: anyone when there is no list."""
    if not names:
        return True
    mine = {who.get("name", "").casefold(), who.get("email", "").casefold()} - {""}
    return any(name.casefold() in mine for name in names)
