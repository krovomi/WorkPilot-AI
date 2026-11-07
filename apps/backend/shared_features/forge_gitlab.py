"""GitLab for a server project, with the token of the person asking.

The GitLab views of the app (issues, merge requests) send their calls here
for a server project, as the GitHub views do to ``forge.py``: the server
makes each call with the caller's own GitLab token, stored on the server.

The instance is one the operator named (``WORKPILOT_GITLAB_HOSTS``, and
gitlab.com), matched against the project's ``repo_url``
(``server.forges.gitlab_project``): a person's token never goes to a host the
project's URL alone chose. A call is one the views make (``_ROUTES``) on the
project, and the URL sent is rebuilt from the instance, the project's path,
the route's own words and numbers, never copied from the request. A write
needs ``vcs.write`` and the member role; opening a merge request
``vcs.pr.create``; a merge ``vcs.pr.merge``. A strict offline policy of the
project blocks the relay.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project
from server.forges import gitlab_project
from shared_board.cards import _require_writer
from shared_features.forge import (
    NUMBER,
    RestCall,
    guard_offline,
    match_route,
    send,
    split_call,
    user_token,
)
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/forge", tags=["features"])

#: The calls the app's GitLab views make below ``/projects/<project>``.
_ROUTES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("GET", ()),
    ("GET", ("issues",)),
    ("GET", ("issues", NUMBER)),
    ("GET", ("issues", NUMBER, "notes")),
    ("GET", ("merge_requests",)),
    ("GET", ("merge_requests", NUMBER)),
    ("GET", ("merge_requests", NUMBER, "changes")),
    ("GET", ("merge_requests", NUMBER, "commits")),
    ("POST", ("merge_requests",)),
    ("POST", ("merge_requests", NUMBER, "notes")),
    ("POST", ("merge_requests", NUMBER, "approve")),
    ("PUT", ("merge_requests", NUMBER)),
    ("PUT", ("merge_requests", NUMBER, "merge")),
    ("PUT", ("merge_requests", NUMBER, "rebase")),
)
_CREATE = ("merge_requests",)
_MERGE = ("merge_requests", NUMBER, "merge")
_QUERY_KEYS = frozenset({"state", "per_page", "page", "order_by", "sort"})


def gitlab_call(
    method: str, endpoint: str, path: str
) -> tuple[str, dict[str, str], tuple[str, ...]] | None:
    """The API path and query parameters to send for a call of the GitLab
    views on project ``path``, with the route it matched; else None."""
    if endpoint == "/user":
        return ("/user", {}, ()) if method == "GET" else None
    # The views name the project as GitLab wants it, its path URL-encoded.
    prefix = f"/projects/{quote(path, safe='')}"
    remainder = endpoint[len(prefix) :]
    if endpoint[: len(prefix)].lower() != prefix.lower() or remainder[:1] not in (
        "",
        "/",
        "?",
    ):
        return None
    found = split_call(method, "/projects/_" + remainder, _QUERY_KEYS)
    if found is None:
        return None
    segments, params = found
    matched = match_route(method, segments[2:], _ROUTES)
    if matched is None:
        return None
    built, route = matched
    return "/".join([prefix, *built]), params, route


async def _project(db: AsyncSession, scope: ProjectScope) -> tuple[str, str]:
    project = await db.get(Project, scope.project_id)
    found = gitlab_project(project.repo_url) if project else None
    if found is None:
        raise HTTPException(status_code=404, detail="Not a GitLab project")
    return found


async def _relay(
    call: RestCall, request: Request, scope: ProjectScope, db: AsyncSession
) -> dict[str, Any]:
    host, path = await _project(db, scope)
    principal = get_principal(request)
    found = gitlab_call(call.method, call.endpoint, path)
    if found is None or call.accept != "json":
        raise HTTPException(status_code=403, detail="Not a call of the GitLab views")
    api_path, params, route = found
    if route == _MERGE and not principal.has("vcs.pr.merge"):
        raise HTTPException(status_code=403, detail="Missing permission: vcs.pr.merge")
    if route == _CREATE and not principal.has("vcs.pr.create"):
        raise HTTPException(status_code=403, detail="Missing permission: vcs.pr.create")
    guard_offline(scope)
    token = await user_token(db, principal, "gitlab_token", "GitLab")
    return await send(
        call.method,
        f"https://{host}/api/v4{api_path}",
        {
            "Content-Type": "application/json",
            "PRIVATE-TOKEN": token,
            "User-Agent": "WorkPilot-AI",
        },
        params=params,
        json=call.body,
    )


@router.post("/gitlab/read")
async def gitlab_read(
    call: RestCall,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A ``GET`` of the project on its GitLab, as the caller."""
    if call.method != "GET" or call.body is not None:
        raise HTTPException(status_code=405, detail="Reads only")
    return await _relay(call, request, scope, db)


@router.post("/gitlab/write")
async def gitlab_write(
    call: RestCall,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A change on the project's GitLab (a note, an approval, a merge
    request opened, updated or merged), as the caller."""
    _require_writer(scope, get_principal(request))
    if call.method == "GET":
        raise HTTPException(status_code=405, detail="Use the read route")
    return await _relay(call, request, scope, db)
