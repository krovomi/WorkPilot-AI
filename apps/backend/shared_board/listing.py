"""Server mode: the board as a list of cards, for clients that draw it themselves.

The desktop app reads a board's files (``GET /api/board/snapshot``) and draws
them with its own loader. The phone app has no such loader and should not
parse a plan of up to a megabyte per card on a mobile connection, so this
route gives each card the way the board's tools already summarise it
(``board_mcp.server.summary``): its title, its column, its kind, its
progress, plus what the server's index adds — the id runs are started with
and who claimed it.

While a build runs, the card's plan is written in its build workspace, not
in the clone's ``.workpilot/specs``; the summary then comes from the
workspace's copy, as the snapshot's ``worktrees`` are preferred by the
desktop. A workspace path is resolved and must stay inside the clone, so a
link planted on the way cannot point the list outside it.

Mounted on the board's router by ``shared_board.api`` (``GET
/api/board/cards``, ``task.read``): any role on the project reads it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import Depends
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project, SpecIndex, User
from server.services.spec_indexer import reindex_project
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: As many cards as the snapshot sends.
MAX_LISTED_CARDS = 500


def card_source(root: Path, directory: Path) -> Path:
    """The copy of the card the board shows: the build workspace's when it has one."""
    from board_mcp.server import SPECS

    workspace = root / ".workpilot" / "worktrees" / "tasks" / directory.name
    copy = workspace / SPECS / directory.name
    if copy.is_dir() and copy.resolve().is_relative_to(root):
        return copy
    return directory


def card_entry(root: Path, directory: Path) -> dict[str, Any]:
    """One card of the list, without the index's fields."""
    from board_mcp.server import details

    card = details(card_source(root, directory))
    card.pop("description", None)
    # The id is the card's folder in the clone, whichever copy was read.
    card["id"] = directory.name
    return card


async def list_board_cards(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The project's cards, newest first, each with its index row's fields."""
    from board_mcp.server import CARD_ID, SPECS

    root = scope.path.resolve()
    project = await db.get(Project, scope.project_id)
    rows: dict[str, SpecIndex] = {}
    if project is not None:
        rows = {row.spec_name: row for row in await reindex_project(db, project)}
    holders = {row.claimed_by for row in rows.values() if row.claimed_by}
    names: dict[str, str] = {}
    if holders:
        result = await db.execute(
            select(User.id, User.display_name).where(User.id.in_(holders))
        )
        names = {user_id: name for user_id, name in result.all()}

    cards: list[dict[str, Any]] = []
    specs = scope.path / SPECS
    entries = sorted(specs.iterdir(), reverse=True) if specs.is_dir() else []
    for entry in entries:
        if len(cards) >= MAX_LISTED_CARDS:
            break
        if not (
            CARD_ID.match(entry.name)
            and entry.is_dir()
            and entry.resolve().is_relative_to(root)
        ):
            continue
        card = card_entry(root, entry)
        row = rows.get(entry.name)
        card["specId"] = row.id if row else None
        card["claimedBy"] = row.claimed_by if row else None
        card["claimedByName"] = (
            names.get(row.claimed_by) if row and row.claimed_by else None
        )
        cards.append(card)
    return {"cards": cards}
