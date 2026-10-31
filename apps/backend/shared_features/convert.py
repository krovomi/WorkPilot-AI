"""Turn an item of a shared feature (a roadmap feature, an idea) into a card.

The desktop app does it on the person's computer: a spec directory, and the
item marked and linked to it. On the server the card is a card of the shared
board, written as ``POST /api/board/cards`` writes one (numbered under the
board's lock), so it starts like any other server card, with its spec written
by the ``spec`` phase. The item is then linked in the feature's file on the
clone, refused while a job writes the feature.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope
from server.services.events import emit_board_event
from shared_board.cards import _index_row, _require_writer
from shared_features.api import (
    ensure_no_job,
    feature_dir,
    read_file,
    sha256,
    write_json_file,
)
from shared_features.registry import Feature
from sqlalchemy.ext.asyncio import AsyncSession

MAX_ITEM_ID = 120


def items(values: Any, limit: int = 100) -> list[str]:
    """The text entries of a list read from a file; anything else is dropped."""
    return (
        [str(v) for v in values if isinstance(v, str | int | float)][:limit]
        if isinstance(values, list)
        else []
    )


def one_line(value: Any, limit: int = 200) -> str:
    return " ".join(str(value or "").split())[:limit]


@dataclass(frozen=True)
class Conversion:
    feature: Feature
    #: The feature's file holding the items, and the list they are under.
    file: str
    list_key: str
    #: The item's card: its title, description and metadata.
    card: Callable[[dict[str, Any]], tuple[str, str, dict[str, Any]]]
    #: Whether the item already has a card.
    converted: Callable[[dict[str, Any]], bool]
    #: Mark the item with its card, and the file it is in.
    link: Callable[[dict[str, Any], dict[str, Any], str], None]


async def convert_item(
    conversion: Conversion,
    item_id: str,
    request: Request,
    scope: ProjectScope,
    db: AsyncSession,
) -> dict[str, Any]:
    from board_mcp.server import summary, write_card
    from core.workspace.models import SpecNumberLockError

    feature = conversion.feature
    principal = get_principal(request)
    _require_writer(scope, principal)
    if not item_id or len(item_id) > MAX_ITEM_ID:
        raise HTTPException(status_code=404, detail="Not found")
    ensure_no_job(scope, feature)
    directory = feature_dir(scope, feature)
    text = read_file(directory, conversion.file, feature.files[conversion.file])
    try:
        document = json.loads(text) if text is not None else None
    except ValueError:
        document = None
    if not isinstance(document, dict):
        raise HTTPException(status_code=404, detail="Not found")
    listed = document.get(conversion.list_key)
    item = next(
        (
            entry
            for entry in (listed if isinstance(listed, list) else [])
            if isinstance(entry, dict) and str(entry.get("id")) == item_id
        ),
        None,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Not found")
    if conversion.converted(item):
        raise HTTPException(status_code=409, detail="Already converted to a card")
    title, description, metadata = conversion.card(item)
    if not title:
        raise HTTPException(status_code=422, detail="It has no title")
    metadata = {
        **metadata,
        "createdBy": principal.id,
        "requireReviewBeforeCoding": True,
    }
    try:
        card_dir = write_card(scope.path, title, description, metadata)
    except SpecNumberLockError as e:
        raise HTTPException(status_code=409, detail="Board busy, try again") from e

    conversion.link(document, item, card_dir.name)
    content = json.dumps(document, indent=2, ensure_ascii=False)
    write_json_file(directory, conversion.file, content)

    row = await _index_row(db, scope, card_dir.name)
    if row is not None and row.created_by is None:
        row.created_by = principal.id
        await db.commit()
    emit_board_event(
        scope.project_id, "spec_created", {"spec": card_dir.name, "by": principal.id}
    )
    emit_board_event(
        scope.project_id,
        "feature_updated",
        {"feature": feature.key, "file": conversion.file, "by": principal.id},
    )
    return {"card": summary(card_dir), "sha256": sha256(content)}
