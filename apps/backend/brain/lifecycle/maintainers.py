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

**Per scope**, for a team too large for one list (the issue's "maintainers
per module"): a ``## <scope>`` heading starts the list of a module, a team
or a branch (`scopes.py`), and the most specific section covering a pair's
scope wins; a pair no section covers falls back to the list at the top.

    - Alice Martin

    ## apps/billing/

    - Carol

    ## team:payments

    - Dan
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from ..notes import inside
from . import scopes
from .journal import LIFECYCLE_DIR, JournalEntry, append

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_MAINTAINERS",
    "MAX_SECTIONS",
    "allows",
    "clean",
    "read",
    "read_all",
    "write",
]

MAX_MAINTAINERS = 20
MAX_SECTIONS = 50
"""Scoped lists in one project, beside the list at the top."""
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


def _readable(name: str) -> bool:
    return bool(name) and len(name) <= _MAX_NAME and not _CONTROL.search(name)


def read_all(root: Path, base: Path | str) -> dict[str, list[str]]:
    """Every list of the memory at *base*: ``""`` is the one at the top.

    Lines a hand edit broke are skipped, and so is a heading that names no
    scope (its names with it): a list must never apply where nobody meant it.
    """
    try:
        text = _path(root, base).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return {}
    found: dict[str, list[str]] = {"": []}
    current: str | None = ""
    for line in text.splitlines():
        if line.startswith("## "):
            scope = scopes.normalise(line[3:])
            current = scope if scope and len(found) <= MAX_SECTIONS else None
            if current is not None:
                found.setdefault(current, [])
        elif current is not None and line.startswith("- "):
            name = line[2:].strip()
            if _readable(name):
                found[current].append(name)
    lists = {
        scope: clean(names[:MAX_MAINTAINERS]) or [] for scope, names in found.items()
    }
    return {scope: names for scope, names in lists.items() if names or not scope}


def read(root: Path, base: Path | str, *, scope: str = "") -> list[str]:
    """Who settles an escalated pair scoped to *scope*: the most specific
    section covering it, else the list at the top."""
    lists = read_all(root, base)
    covering = [s for s in lists if s and scope and scopes.covers(s, scope)]
    if covering:
        return lists[max(covering, key=len)]
    return lists.get("", [])


def _render(lists: dict[str, list[str]]) -> str:
    parts = [_HEADER, "".join(f"- {name}\n" for name in lists.get("", []))]
    for scope in sorted(s for s in lists if s):
        parts.append(f"\n## {scope}\n\n" + "".join(f"- {n}\n" for n in lists[scope]))
    return "".join(parts)


def write(
    root: Path,
    base: Path | str,
    names: list[str],
    *,
    scope: str = "",
    actor: str = "user",
) -> list[str] | None:
    """Replace one list (*scope*, the top one by default); an empty scoped
    list is removed. ``None`` when a name or the scope is refused (nothing is
    written)."""
    kept = clean(names)
    where = scopes.normalise(scope)
    if kept is None or where is None:
        return None
    lists = read_all(root, base)
    if kept or not where:
        lists[where] = kept
    else:
        lists.pop(where, None)
    if len([s for s in lists if s]) > MAX_SECTIONS:
        return None
    target = _path(root, base)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_render(lists), encoding="utf-8", newline="\n")
    reason = ", ".join(kept)
    append(
        root,
        base,
        JournalEntry(
            action="designate",
            actor=actor,
            note=(Path(base) / LIFECYCLE_DIR / _FILE).as_posix(),
            title="maintainers",
            reason_code="maintainers-changed",
            reason=f"{where} : {reason}" if where else reason,
        ),
    )
    return kept


def allows(names: list[str], who: dict[str, str]) -> bool:
    """Whether *who* settles an escalated pair: anyone when there is no list."""
    if not names:
        return True
    mine = {who.get("name", "").casefold(), who.get("email", "").casefold()} - {""}
    return any(name.casefold() in mine for name in names)
