"""The shared ideation's own route: turn one of its ideas into a card of the
shared board (``shared_features.convert``), the idea archived and linked to it
in ``ideation.json``.

The card's text and metadata are those the desktop app writes
(``ipc-handlers/ideation/task-converter.ts``), so a card made from an idea
reads the same on a server project as on a local one.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from shared_features.convert import Conversion, convert_item, items, one_line
from shared_features.registry import IDEATION
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/ideation", tags=["features"])

CATEGORY = {
    "code_improvements": "feature",
    "ui_ux_improvements": "ui_ux",
    "documentation_gaps": "documentation",
    "security_hardening": "security",
    "performance_optimizations": "performance",
    "code_quality": "refactoring",
}
SECURITY_PRIORITY = {"critical": "urgent", "high": "high"}
QUALITY_PRIORITY = {"critical": "urgent", "major": "high"}


def _text(value: Any, limit: int = 4_000) -> str:
    return str(value)[:limit] if isinstance(value, str | int | float) else ""


def _bullets(values: Any) -> str:
    return "\n".join(f"- {v}" for v in items(values))


def card_text(idea: dict[str, Any]) -> tuple[str, str]:
    title = one_line(idea.get("title"))
    description = (
        f"# {title}\n\n{_text(idea.get('description'))}\n\n"
        f"## Rationale\n{_text(idea.get('rationale'))}\n\n"
    )
    kind = idea.get("type")
    if kind == "code_improvements":
        if items(idea.get("builds_upon")):
            description += f"## Builds Upon\n{_bullets(idea.get('builds_upon'))}\n\n"
        if _text(idea.get("implementation_approach")):
            description += (
                "## Implementation Approach\n"
                f"{_text(idea.get('implementation_approach'))}\n\n"
            )
        if items(idea.get("affected_files")):
            description += (
                f"## Affected Files\n{_bullets(idea.get('affected_files'))}\n\n"
            )
        if items(idea.get("existing_patterns")):
            description += (
                f"## Patterns to Follow\n{_bullets(idea.get('existing_patterns'))}\n\n"
            )
    elif kind == "ui_ux_improvements":
        for heading, key in (
            ("Category", "category"),
            ("Current State", "current_state"),
            ("Proposed Change", "proposed_change"),
            ("User Benefit", "user_benefit"),
        ):
            description += f"## {heading}\n{_text(idea.get(key))}\n\n"
        if items(idea.get("affected_components")):
            description += (
                "## Affected Components\n"
                f"{_bullets(idea.get('affected_components'))}\n\n"
            )
    return title, description[:20_000]


def card_metadata(idea: dict[str, Any]) -> dict[str, Any]:
    kind = _text(idea.get("type"), 40)
    metadata: dict[str, Any] = {
        "sourceType": "ideation",
        "ideationType": kind,
        "ideaId": _text(idea.get("id"), 120),
        "rationale": _text(idea.get("rationale")),
        "category": CATEGORY.get(kind, "feature"),
    }
    effort = _text(idea.get("estimated_effort"), 40) or None
    severity = _text(idea.get("severity"), 40) or None
    files_key = {
        "code_improvements": "affected_files",
        "ui_ux_improvements": "affected_components",
        "documentation_gaps": "affected_areas",
        "security_hardening": "affected_files",
        "performance_optimizations": "affected_areas",
        "code_quality": "affected_files",
    }.get(kind)
    if files_key and isinstance(idea.get(files_key), list):
        metadata["affectedFiles"] = items(idea.get(files_key))
    if kind == "code_improvements":
        metadata.update(estimatedEffort=effort, complexity=effort)
    elif kind == "ui_ux_improvements":
        metadata.update(
            uiuxCategory=_text(idea.get("category"), 80) or None,
            problemSolved=_text(idea.get("current_state")) or None,
        )
    elif kind == "documentation_gaps":
        metadata.update(
            estimatedEffort=effort,
            priority=_text(idea.get("priority"), 40) or None,
            targetAudience=_text(idea.get("target_audience"), 200) or None,
        )
    elif kind == "security_hardening":
        metadata.update(
            securitySeverity=severity,
            impact=severity,
            priority=SECURITY_PRIORITY.get(severity or "", "medium"),
        )
    elif kind == "performance_optimizations":
        metadata.update(
            performanceCategory=_text(idea.get("category"), 80) or None,
            impact=_text(idea.get("impact"), 40) or None,
            estimatedEffort=effort,
        )
    elif kind == "code_quality":
        metadata.update(
            codeQualitySeverity=severity,
            estimatedEffort=effort,
            priority=QUALITY_PRIORITY.get(severity or "", "medium"),
        )
    return {key: value for key, value in metadata.items() if value is not None}


def _card(idea: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    title, description = card_text(idea)
    return title, description, card_metadata(idea)


def _link(ideation: dict[str, Any], idea: dict[str, Any], card_id: str) -> None:
    # A converted idea is archived, as the app does.
    idea["status"] = "archived"
    idea["linked_task_id"] = card_id
    ideation["updated_at"] = datetime.now(UTC).isoformat()


IDEATION_CONVERSION = Conversion(
    feature=IDEATION,
    file="ideation.json",
    list_key="ideas",
    card=_card,
    converted=lambda idea: bool(idea.get("linked_task_id")),
    link=_link,
)


@router.post("/ideas/{idea_id}/convert", status_code=201)
async def convert_idea(
    idea_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await convert_item(IDEATION_CONVERSION, idea_id, request, scope, db)
