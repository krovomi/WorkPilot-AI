"""What the board's routes share: who may change a card, which card an id
names, and its row in the server's index."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException
from server.authz.principal import Principal
from server.authz.scope import ProjectScope
from server.db.models import Project, ProjectRole, SpecIndex
from server.services.spec_indexer import reindex_project
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

_WRITER_ROLES = {ProjectRole.MEMBER.value, ProjectRole.OWNER.value}


def _require_writer(scope: ProjectScope, principal: Principal) -> None:
    # An organization administrator reaches a project without a membership
    # row (``project_role`` is None); everyone else needs member or owner.
    if scope.project_role is None:
        if principal.is_platform_admin or principal.has("project.member.write"):
            return
    elif scope.project_role in _WRITER_ROLES:
        return
    raise HTTPException(status_code=403, detail="Requires project role 'member'")


def _card_or_404(scope: ProjectScope, card_id: str) -> Path:
    from board_mcp.server import card_dir

    directory = card_dir(scope.path, card_id)
    if directory is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return directory


async def _index_row(
    db: AsyncSession, scope: ProjectScope, card_id: str
) -> SpecIndex | None:
    project = await db.get(Project, scope.project_id)
    if project is not None:
        await reindex_project(db, project)
    return await db.scalar(
        select(SpecIndex).where(
            SpecIndex.project_id == scope.project_id, SpecIndex.spec_name == card_id
        )
    )
