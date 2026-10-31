"""GitHub for a server project, with the token of the person asking.

The GitHub views of the app call GitHub's API. For a server project the app
sends each call here instead, and the server makes it with the caller's own
token (``server.services.secrets``, set in the app's "My tokens on the
server"): what a person reads or does on GitHub is done as them, from any
computer, and no other person's token is ever used for them.

The relay is kept to the project's own repository, read from the project's
``repo_url`` on the server, never from the request:

- a REST path is ``/repos/<owner>/<repo>`` or below it, or ``/user`` (whose
  token this is), with no scheme, host, ``..`` or percent-escape;
- GraphQL serves one query, the open pull requests of the project's
  repository, written here with the repository filled in by the server;
- a write is one of the changes the views make (a comment, an assignee, a
  branch brought up to date, a workflow approved, a merge), never any other
  call of the API; it needs ``vcs.write`` and the member role, a merge
  ``vcs.pr.merge``.

A strict offline policy of the project blocks the relay. A token is never
logged nor returned; GitHub's answer is passed back with its status.
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project
from server.services.secrets import SecretsVaultError, get_user_secret
from shared_board.cards import _require_writer
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/forge", tags=["features"])

GITHUB_API = "https://api.github.com"
MAX_PATH = 2_000
MAX_CURSOR = 200
MAX_ANSWER = 8_000_000
TIMEOUT = 30.0

#: ``owner/repo`` from the URL a project was cloned from: github.com only.
_GITHUB_URL = re.compile(
    r"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)"
    r"(?P<repo>[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$"
)
_MERGE = re.compile(r"^/repos/[^/]+/[^/]+/pulls/\d+/merge$", re.IGNORECASE)
#: The changes the app's GitHub views make, and only those: the write route
#: is not a way to reach all of GitHub's API with the person's token.
_WRITES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("POST", re.compile(r"^/repos/[^/]+/[^/]+/issues/\d+/comments$", re.IGNORECASE)),
    ("POST", re.compile(r"^/repos/[^/]+/[^/]+/issues/\d+/assignees$", re.IGNORECASE)),
    ("PUT", re.compile(r"^/repos/[^/]+/[^/]+/pulls/\d+/update-branch$", re.IGNORECASE)),
    (
        "POST",
        re.compile(r"^/repos/[^/]+/[^/]+/actions/runs/\d+/approve$", re.IGNORECASE),
    ),
    ("PUT", _MERGE),
)

Method = Literal["GET", "POST", "PATCH", "PUT", "DELETE"]


class RestCall(BaseModel):
    model_config = ConfigDict(extra="forbid")

    method: Method = "GET"
    #: The API endpoint below ``https://api.github.com`` (``/repos/…``).
    endpoint: str = Field(min_length=1, max_length=MAX_PATH)
    body: dict[str, Any] | list[Any] | None = None
    #: ``diff`` asks GitHub for a pull request's diff as text.
    accept: Literal["json", "diff"] = "json"


class PullsPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first: int = Field(default=100, ge=1, le=100)
    after: str | None = Field(default=None, max_length=MAX_CURSOR)


#: The app's list of open pull requests (``pr-graphql.ts``), with their diff
#: stats, which the REST list does not give.
OPEN_PULLS_QUERY = """
query($owner: String!, $repo: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, after: $after,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state author { login } headRefName baseRefName
        additions deletions changedFiles
        assignees(first: 10) { nodes { login } }
        createdAt updatedAt url
      }
    }
  }
}
"""


def github_repo(repo_url: str) -> str | None:
    """``owner/repo`` of a GitHub URL, else None."""
    match = _GITHUB_URL.match((repo_url or "").strip())
    return match.group("repo") if match else None


def allowed_path(path: str, repo: str) -> bool:
    """A path of the project's repository (or ``/user``), and nothing else."""
    if any(c in path for c in ("\\", "#", "%", "@")) or any(
        ord(c) < 0x21 for c in path
    ):
        return False
    split = urlsplit(path)
    if split.scheme or split.netloc or not split.path.startswith("/"):
        return False
    segments = split.path.split("/")[1:]
    if any(s in ("", ".", "..") for s in segments):
        return False
    if split.path == "/user":
        return True
    prefix = f"/repos/{repo}".lower()
    lowered = split.path.lower()
    return lowered == prefix or lowered.startswith(prefix + "/")


async def _project_repo(db: AsyncSession, scope: ProjectScope) -> str:
    project = await db.get(Project, scope.project_id)
    repo = github_repo(project.repo_url) if project else None
    if repo is None:
        raise HTTPException(status_code=404, detail="Not a GitHub project")
    return repo


def _guard_offline(scope: ProjectScope) -> None:
    from offline_policy import guard_cloud_client

    try:
        guard_cloud_client(scope.path)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


async def _token(db: AsyncSession, principal: Principal) -> str:
    try:
        token = await get_user_secret(db, principal.id, "github_token")
    except SecretsVaultError as e:
        raise HTTPException(status_code=503, detail="Tokens unavailable") from e
    if not token:
        raise HTTPException(
            status_code=412,
            detail="Add your GitHub token in Settings → My tokens on the server",
        )
    return token


async def _send(
    token: str,
    method: str,
    url: str,
    *,
    json: Any = None,
    accept: str = "application/vnd.github+json",
) -> dict[str, Any]:
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {token}",
        "User-Agent": "WorkPilot-AI",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
            answer = await client.request(method, url, headers=headers, json=json)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail="GitHub unreachable") from e
    if len(answer.content) > MAX_ANSWER:
        raise HTTPException(status_code=502, detail="GitHub's answer is too large")
    if accept.endswith("diff"):
        return {"status": answer.status_code, "text": answer.text}
    try:
        body = answer.json() if answer.content else None
    except ValueError:
        body = None
    return {"status": answer.status_code, "body": body}


async def _relay(
    call: RestCall, request: Request, scope: ProjectScope, db: AsyncSession
) -> dict[str, Any]:
    repo = await _project_repo(db, scope)
    if not allowed_path(call.endpoint, repo):
        raise HTTPException(status_code=403, detail="Outside the project's repository")
    if call.endpoint == "/user" and call.method != "GET":
        raise HTTPException(status_code=403, detail="Outside the project's repository")
    _guard_offline(scope)
    token = await _token(db, get_principal(request))
    return await _send(
        token,
        call.method,
        GITHUB_API + call.endpoint,
        json=call.body,
        accept="application/vnd.github.diff"
        if call.accept == "diff"
        else "application/vnd.github+json",
    )


@router.post("/github/read")
async def github_read(
    call: RestCall,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A ``GET`` of the project's repository, as the caller."""
    if call.method != "GET" or call.body is not None:
        raise HTTPException(status_code=405, detail="Reads only")
    return await _relay(call, request, scope, db)


@router.post("/github/write")
async def github_write(
    call: RestCall,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A change on the project's repository (a comment, a review, an
    assignee, a merge…), as the caller."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    if call.method == "GET":
        raise HTTPException(status_code=405, detail="Use the read route")
    split = urlsplit(call.endpoint)
    if split.query or not any(
        call.method == method and pattern.match(split.path)
        for method, pattern in _WRITES
    ):
        raise HTTPException(status_code=403, detail="Not a change the views make")
    if _MERGE.match(split.path) and not principal.has("vcs.pr.merge"):
        raise HTTPException(status_code=403, detail="Missing permission: vcs.pr.merge")
    return await _relay(call, request, scope, db)


@router.post("/github/pulls")
async def github_pulls(
    page: PullsPage,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A page of the project's open pull requests (GraphQL), as the caller."""
    repo = await _project_repo(db, scope)
    _guard_offline(scope)
    token = await _token(db, get_principal(request))
    owner, name = repo.split("/", 1)
    variables = {"owner": owner, "repo": name, "first": page.first, "after": page.after}
    return await _send(
        token,
        "POST",
        GITHUB_API + "/graphql",
        json={"query": OPEN_PULLS_QUERY, "variables": variables},
    )
