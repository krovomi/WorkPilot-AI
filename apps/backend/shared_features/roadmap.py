"""The shared roadmap's own route: turn one of its features into a card.

The desktop app does it on the person's computer: a spec directory, and the
feature marked ``planned`` and linked to it. On the server the card is a
card of the shared board, written as ``POST /api/board/cards`` writes one
(numbered under the board's lock), so it starts like any other server card,
with its spec written by the ``spec`` phase. The feature is then linked in
``roadmap.json`` on the clone, refused while a job writes the roadmap.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.services.events import emit_board_event
from shared_board.cards import _index_row, _require_writer
from shared_features.api import (
    ensure_no_job,
    feature_dir,
    read_file,
    sha256,
    write_json_file,
)
from shared_features.registry import ROADMAP
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/roadmap", tags=["features"])

ROADMAP_FILE = "roadmap.json"
MAX_FEATURE_ID = 120


def _items(values: Any) -> list[str]:
    return (
        [str(v) for v in values if isinstance(v, str | int | float)][:100]
        if isinstance(values, list)
        else []
    )


def card_text(feature: dict[str, Any]) -> tuple[str, str]:
    """The card's title and description, as the app writes them."""
    title = " ".join(str(feature.get("title") or "").split())[:200]
    stories = "\n".join(f"- {s}" for s in _items(feature.get("user_stories")))
    criteria = "\n".join(
        f"- [ ] {c}" for c in _items(feature.get("acceptance_criteria"))
    )
    description = (
        f"# {title}\n\n{feature.get('description') or ''}\n\n"
        f"## Rationale\n{feature.get('rationale') or 'N/A'}\n\n"
        f"## User Stories\n{stories or 'N/A'}\n\n"
        f"## Acceptance Criteria\n{criteria or 'N/A'}\n"
    )
    return title, description[:20_000]


@router.post("/features/{feature_id}/convert", status_code=201)
async def convert_feature(
    feature_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from board_mcp.server import summary, write_card
    from core.workspace.models import SpecNumberLockError

    principal = get_principal(request)
    _require_writer(scope, principal)
    if not feature_id or len(feature_id) > MAX_FEATURE_ID:
        raise HTTPException(status_code=404, detail="Feature not found")
    ensure_no_job(scope, ROADMAP)
    directory = feature_dir(scope, ROADMAP)
    text = read_file(directory, ROADMAP_FILE, ROADMAP.files[ROADMAP_FILE])
    try:
        roadmap = json.loads(text) if text is not None else None
    except ValueError:
        roadmap = None
    if not isinstance(roadmap, dict):
        raise HTTPException(status_code=404, detail="Roadmap not found")
    features = roadmap.get("features")
    feature = next(
        (
            f
            for f in (features if isinstance(features, list) else [])
            if isinstance(f, dict) and str(f.get("id")) == feature_id
        ),
        None,
    )
    if feature is None:
        raise HTTPException(status_code=404, detail="Feature not found")
    if feature.get("linked_spec_id"):
        raise HTTPException(status_code=409, detail="Already converted to a card")
    title, description = card_text(feature)
    if not title:
        raise HTTPException(status_code=422, detail="The feature has no title")

    metadata: dict[str, Any] = {
        "sourceType": "roadmap",
        "featureId": feature_id,
        "category": "feature",
        "createdBy": principal.id,
        "requireReviewBeforeCoding": True,
    }
    try:
        card_dir = write_card(scope.path, title, description, metadata)
    except SpecNumberLockError as e:
        raise HTTPException(status_code=409, detail="Board busy, try again") from e

    feature["status"] = "planned"
    feature["linked_spec_id"] = card_dir.name
    meta = roadmap.get("metadata")
    roadmap["metadata"] = {
        **(meta if isinstance(meta, dict) else {}),
        "updated_at": datetime.now(UTC).isoformat(),
    }
    content = json.dumps(roadmap, indent=2, ensure_ascii=False)
    write_json_file(directory, ROADMAP_FILE, content)

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
        {"feature": ROADMAP.key, "file": ROADMAP_FILE, "by": principal.id},
    )
    return {"card": summary(card_dir), "roadmap_sha256": sha256(content)}
