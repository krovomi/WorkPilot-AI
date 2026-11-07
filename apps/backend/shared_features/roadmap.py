"""The shared roadmap's own route: turn one of its features into a card of
the shared board (``shared_features.convert``), the feature marked
``planned`` and linked to it in ``roadmap.json``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from shared_features.convert import Conversion, convert_item, items, one_line
from shared_features.registry import ROADMAP
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/roadmap", tags=["features"])


def card_text(feature: dict[str, Any]) -> tuple[str, str]:
    """The card's title and description, as the app writes them."""
    title = one_line(feature.get("title"))
    stories = "\n".join(f"- {s}" for s in items(feature.get("user_stories")))
    criteria = "\n".join(
        f"- [ ] {c}" for c in items(feature.get("acceptance_criteria"))
    )
    description = (
        f"# {title}\n\n{feature.get('description') or ''}\n\n"
        f"## Rationale\n{feature.get('rationale') or 'N/A'}\n\n"
        f"## User Stories\n{stories or 'N/A'}\n\n"
        f"## Acceptance Criteria\n{criteria or 'N/A'}\n"
    )
    return title, description[:20_000]


def _card(feature: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    title, description = card_text(feature)
    metadata = {
        "sourceType": "roadmap",
        "featureId": str(feature.get("id")),
        "category": "feature",
    }
    return title, description, metadata


def _link(roadmap: dict[str, Any], feature: dict[str, Any], card_id: str) -> None:
    feature["status"] = "planned"
    feature["linked_spec_id"] = card_id
    meta = roadmap.get("metadata")
    roadmap["metadata"] = {
        **(meta if isinstance(meta, dict) else {}),
        "updated_at": datetime.now(UTC).isoformat(),
    }


ROADMAP_CONVERSION = Conversion(
    feature=ROADMAP,
    file="roadmap.json",
    list_key="features",
    card=_card,
    converted=lambda feature: bool(feature.get("linked_spec_id")),
    link=_link,
)


@router.post("/features/{feature_id}/convert", status_code=201)
async def convert_feature(
    feature_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await convert_item(ROADMAP_CONVERSION, feature_id, request, scope, db)
