"""GitHub for a server project, with the token of the person asking.

The GitHub views of the app call GitHub's API. For a server project the app
sends each call here instead, and the server makes it with the caller's own
token (``server.services.secrets``, set in the app's "My tokens on the
server"): what a person reads or does on GitHub is done as them, from any
computer, and no other person's token is ever used for them.

The relay is kept to the project's own repository, read from the project's
``repo_url`` on the server, never from the request:

- a REST call is one of the calls the views make (``_ROUTES``) on
  ``/repos/<owner>/<repo>``, or a read of ``/user`` (whose token this is);
  the URL sent is rebuilt from the route's own words, the project's
  repository and numbers, never copied from the request, and the query
  string keeps only the views' keys, sent as parameters;
- GraphQL serves one query, the open pull requests of the project's
  repository, written here with the repository filled in by the server;
- a write (a comment, an assignee, a branch brought up to date, a workflow
  approved, a merge) needs ``vcs.write`` and the member role, a merge
  ``vcs.pr.merge``.

A strict offline policy of the project blocks the relay. A token is never
logged nor returned; GitHub's answer is passed back with its status.
"""

from __future__ import annotations

import re
from typing import Any, Literal
from urllib.parse import parse_qsl, urlsplit

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
#: The kinds of a path's variable segments.
NUMBER, COMMIT, RANGE = "<number>", "<commit>", "<range>"
#: The calls the app's GitHub views make below ``/repos/<owner>/<repo>``,
#: and only those: the relay is not a way to reach all of GitHub's API with
#: the person's token.
_ROUTES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("GET", ()),
    ("GET", ("issues",)),
    ("GET", ("issues", NUMBER)),
    ("GET", ("issues", NUMBER, "comments")),
    ("GET", ("pulls", NUMBER)),
    ("GET", ("pulls", NUMBER, "files")),
    ("GET", ("commits", COMMIT, "status")),
    ("GET", ("commits", COMMIT, "check-runs")),
    ("GET", ("compare", RANGE)),
    ("GET", ("actions", "runs")),
    ("POST", ("issues", NUMBER, "comments")),
    ("POST", ("issues", NUMBER, "assignees")),
    ("PUT", ("pulls", NUMBER, "merge")),
    ("PUT", ("pulls", NUMBER, "update-branch")),
    ("POST", ("actions", "runs", NUMBER, "approve")),
)
_MERGE = ("pulls", NUMBER, "merge")
_QUERY_KEYS = frozenset({"state", "per_page", "sort", "page", "status"})
_QUERY_VALUE_MAX = 100
_COMMIT = re.compile(r"[0-9a-fA-F]{7,40}")

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


def _number(text: str) -> str | None:
    return (
        str(int(text))
        if text.isascii() and text.isdigit() and len(text) <= 12
        else None
    )


def _commit(text: str) -> str | None:
    # Written back from its value: nothing of the request's text is kept.
    if not _COMMIT.fullmatch(text):
        return None
    return f"{int(text, 16):0{len(text)}x}"


def _segment(kind: str, text: str) -> str | None:
    if kind == NUMBER:
        return _number(text)
    if kind == COMMIT:
        return _commit(text)
    if kind == RANGE:
        ends = text.split("...")
        commits = [_commit(end) for end in ends]
        if len(ends) != 2 or None in commits:
            return None
        return f"{commits[0]}...{commits[1]}"
    return kind if text == kind else None


def api_call(
    method: str, endpoint: str, repo: str
) -> tuple[str, dict[str, str], tuple[str, ...]] | None:
    """The path and query parameters to send for a call of the views, with
    the route it matched; None for any other call.

    The path is rebuilt from the route, the project's ``repo`` and numbers:
    it holds no text of ``endpoint``.
    """
    if any(c in endpoint for c in ("\\", "#", "%", "@")) or any(
        ord(c) < 0x21 for c in endpoint
    ):
        return None
    split = urlsplit(endpoint)
    if split.scheme or split.netloc or not split.path.startswith("/"):
        return None
    pairs = parse_qsl(split.query, keep_blank_values=True)
    keys = [key for key, _ in pairs]
    if (
        (pairs and method != "GET")
        or len(set(keys)) != len(keys)
        or any(key not in _QUERY_KEYS for key in keys)
        or any(len(value) > _QUERY_VALUE_MAX for _, value in pairs)
    ):
        return None
    params = dict(pairs)
    segments = split.path.split("/")[1:]
    if segments == ["user"]:
        return ("/user", params, ()) if method == "GET" else None
    owner, name = repo.split("/", 1)
    if (
        len(segments) < 3
        or segments[0] != "repos"
        or segments[1].lower() != owner.lower()
        or segments[2].lower() != name.lower()
    ):
        return None
    rest = segments[3:]
    for route_method, route in _ROUTES:
        if route_method != method or len(route) != len(rest):
            continue
        built = [_segment(kind, text) for kind, text in zip(route, rest, strict=True)]
        if None not in built:
            path = "/".join([f"/repos/{repo}", *(b for b in built if b is not None)])
            return path, params, route
    return None


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
    params: dict[str, str] | None = None,
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
            answer = await client.request(
                method, url, headers=headers, params=params, json=json
            )
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
    principal = get_principal(request)
    found = api_call(call.method, call.endpoint, repo)
    if found is None:
        raise HTTPException(status_code=403, detail="Not a call of the GitHub views")
    path, params, route = found
    if route == _MERGE and not principal.has("vcs.pr.merge"):
        raise HTTPException(status_code=403, detail="Missing permission: vcs.pr.merge")
    _guard_offline(scope)
    token = await _token(db, principal)
    return await _send(
        token,
        call.method,
        GITHUB_API + path,
        params=params,
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
    _require_writer(scope, get_principal(request))
    if call.method == "GET":
        raise HTTPException(status_code=405, detail="Use the read route")
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
