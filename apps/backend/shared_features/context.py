"""The Context view of a server project: what its builds remember.

The project's index is a file of the clone, served and rebuilt like any
declared feature (``registry.CONTEXT``). Its memories are the project's own
brain (``server.services.run_isolation.project_brain``): every run of the
project learns into it, whoever started the run, and every member reads it
here. On the desktop the Memories tab reads the person's brain instead; on a
shared server that brain would be the server user's, one for every tenant.

What a build wrote is passed through ``redact_text`` before it is served,
like a job's output. A route takes a ``project_id``, never a path
(``resolve_project_scope``), and serves nothing of where the brain is.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Query
from server.authz.scope import ProjectScope, resolve_project_scope
from server.config import get_settings
from server.services.run_isolation import project_brain

router = APIRouter(prefix="/api/features/context", tags=["features"])

MAX_LIMIT = 200
MAX_QUERY = 500


def _redacted(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from foundation.log_redaction import redact_text

    return [
        {**row, "content": redact_text(str(row.get("content") or ""))} for row in rows
    ]


def read_memories(scope: ProjectScope, query: str, limit: int) -> dict[str, Any]:
    """The project's memories (``query`` ranks them), and whether its brain
    exists yet: it is created by the first build that learns something."""
    from brain.project_memory import list_memories, search_memories
    from brain.tasks import project_name_from
    from brain.vault import Brain

    brain = Brain(project_brain(get_settings().repos_root, scope.project_id))
    key = "results" if query else "memories"
    if not brain.exists:
        return {"available": False, key: []}
    # The name a build of this clone files its notes under
    # (``brain.tasks.project_name``), read from the server's own path.
    project = project_name_from(str(scope.path))
    rows = (
        search_memories(project, query, limit=limit, brain=brain)
        if query
        else list_memories(project, limit=limit, brain=brain)
    )
    return {"available": True, key: _redacted(rows)}


@router.get("/memories")
async def memories(
    query: str = Query(default="", max_length=MAX_QUERY),
    limit: int = Query(default=20, ge=1, le=MAX_LIMIT),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The Memories tab: the most recent first, or ranked against ``query``."""
    return await asyncio.to_thread(read_memories, scope, query.strip(), limit)
