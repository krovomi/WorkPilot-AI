"""The AI review of a server project's pull requests, run on the server.

The desktop app reviews a pull request by starting the GitHub runner
(``runners/github/runner.py review-pr``) in the project's folder. A server
project has no folder on the computer: the review runs here, as a job on the
project's clone, like the roadmap or the ideation (``project_jobs``), and the
app follows it and reads its result through these routes.

The job is the runner, its repository the project's own (``--repo`` from its
``repo_url``, never from the request), its pull request a number. It runs
with the GitHub token of the person who starts it, as every run does
(``run_manager`` puts the launcher's stored tokens in its environment):
nothing starts without one. The result is the runner's own file,
``.workpilot/github/pr/review_<n>.json`` in the clone, which every member of
the project reads. A strict offline policy of the project blocks the job, as
it blocks the relay.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectJob
from server.services.project_jobs import get_project_jobs
from server.services.run_manager import RunManagerError
from shared_board.cards import _require_writer
from shared_features.api import (
    job_public,
    job_with_output,
    read_file,
    write_json_file,
)
from shared_features.forge import guard_offline, project_repo, user_token
from shared_features.registry import MODEL_PATTERN
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/forge/github/reviews", tags=["features"])

#: The job's name in ``project_jobs``, and the runner it starts.
FEATURE = "github-review"
RUNNER = "github/runner.py"
#: Where the runner writes a review, relative to the clone.
REVIEW_DIR = ".workpilot/github/pr"
MAX_REVIEW = 2_000_000
MAX_NUMBERS = 50
PR_MAX = 10**9
_NUMBERS = re.compile(r"^[1-9][0-9]{0,9}(?:,[1-9][0-9]{0,9}){0,49}$")


class Posted(BaseModel):
    """What the person posted of a review on GitHub."""

    model_config = ConfigDict(extra="forbid")

    finding_ids: list[str] = Field(default_factory=list, max_length=500)
    review_id: int | None = Field(default=None, ge=1)


class ReviewJob(BaseModel):
    """What a review job takes; the runner's own choices of thinking level."""

    model_config = ConfigDict(extra="forbid")

    pr_number: int = Field(ge=1, le=PR_MAX)
    #: A follow-up of the last review, on what changed since.
    followup: bool = False
    model: str | None = Field(default=None, pattern=MODEL_PATTERN)
    thinking_level: Literal["none", "low", "medium", "high"] | None = None


def review_args(repo: str, job: ReviewJob) -> list[str]:
    """The runner's arguments after ``--project <clone>``."""
    args = ["--repo", repo]
    if job.model:
        args += ["--model", job.model]
    if job.thinking_level:
        args += ["--thinking-level", job.thinking_level]
    command = "followup-review-pr" if job.followup else "review-pr"
    return [*args, command, str(job.pr_number)]


@router.post("/jobs", status_code=202)
async def start_review(
    request: Request,
    body: dict[str, Any] = Body(default_factory=dict),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Review a pull request of the project, as the caller."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    try:
        job = ReviewJob.model_validate(body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Invalid review") from e
    repo = await project_repo(db, scope)
    guard_offline(scope)
    # The run reads the same token; without one it could only fail later.
    await user_token(db, principal, "github_token", "GitHub")
    try:
        started = await get_project_jobs().start(
            project_id=scope.project_id,
            org_id=scope.org_id,
            server_path=str(scope.path),
            feature=FEATURE,
            runner=RUNNER,
            args=review_args(repo, job),
            user_id=principal.id,
            # One review of a pull request at a time; others run beside it.
            slot=f"{FEATURE}:{job.pr_number}",
        )
    except RunManagerError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return job_public(started)


async def _own_job(db: AsyncSession, scope: ProjectScope, job_id: str) -> ProjectJob:
    job = await db.get(ProjectJob, job_id)
    if job is None or job.project_id != scope.project_id or job.feature != FEATURE:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/jobs/{job_id}")
async def get_review_job(
    job_id: str,
    after: int = Query(default=0, ge=0),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A review job and the lines of its output after line ``after``."""
    return await job_with_output(db, scope, await _own_job(db, scope, job_id), after)


@router.post("/jobs/{job_id}/cancel")
async def cancel_review_job(
    job_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    _require_writer(scope, get_principal(request))
    job = await _own_job(db, scope, job_id)
    return {"cancelled": await get_project_jobs().cancel(job.id)}


def _review_dir(scope: ProjectScope) -> Path:
    """The runner's review directory in the clone, refused if a link leads
    it out."""
    root = scope.path.resolve()
    directory = scope.path / REVIEW_DIR
    if directory.exists() and not directory.resolve().is_relative_to(root):
        raise HTTPException(status_code=409, detail="Reviews unavailable")
    return directory


@router.get("")
async def get_reviews(
    numbers: str = Query(max_length=11 * MAX_NUMBERS),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, dict[str, str | None]]:
    """The saved reviews of pull requests ``numbers`` (comma-separated), as
    the runner wrote them; null for one never reviewed."""
    if not _NUMBERS.match(numbers):
        raise HTTPException(status_code=422, detail="Not pull request numbers")
    directory = _review_dir(scope)
    reviews: dict[str, str | None] = {}
    for number in dict.fromkeys(int(n) for n in numbers.split(",")):
        if number > PR_MAX:
            continue
        reviews[str(number)] = read_file(directory, f"review_{number}.json", MAX_REVIEW)
    return {"reviews": reviews}


@router.post("/{pr_number}/posted")
async def mark_posted(
    pr_number: int,
    request: Request,
    body: Posted,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, bool]:
    """Record on the saved review what the person posted of it on GitHub, as
    the app does in a local project's file: the follow-up review starts from
    it."""
    _require_writer(scope, get_principal(request))
    if not 1 <= pr_number <= PR_MAX:
        raise HTTPException(status_code=422, detail="Not a pull request number")
    if any(len(i) > 200 for i in body.finding_ids):
        raise HTTPException(status_code=422, detail="Not finding ids")
    if get_project_jobs().running_job(scope.project_id, f"{FEATURE}:{pr_number}"):
        raise HTTPException(status_code=409, detail="The review is running")
    directory = _review_dir(scope)
    name = f"review_{pr_number}.json"
    text = read_file(directory, name, MAX_REVIEW)
    try:
        data = json.loads(text) if text is not None else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise HTTPException(status_code=404, detail="No review of this pull request")
    if body.review_id is not None:
        data["review_id"] = body.review_id
    data["has_posted_findings"] = True
    posted = data.get("posted_finding_ids")
    data["posted_finding_ids"] = list(
        dict.fromkeys(
            [*(posted if isinstance(posted, list) else []), *body.finding_ids]
        )
    )
    data["posted_at"] = datetime.now(UTC).isoformat()
    write_json_file(directory, name, json.dumps(data, indent=2))
    return {"posted": True}
