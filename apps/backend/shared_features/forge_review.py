"""The AI review of a server project's pull or merge requests, run on the
server.

The desktop app reviews a GitHub pull request or a GitLab merge request by
starting the forge's runner (``runners/github/runner.py review-pr``,
``runners/gitlab/runner.py review-mr``) in the project's folder. A server
project has no folder on the computer: the review runs here, as a job on the
project's clone, like the roadmap or the ideation (``project_jobs``), and the
app follows it and reads its result through these routes, one set per forge
(``/api/features/forge/<forge>/reviews``).

The job is the runner, its repository the project's own (from its
``repo_url``, never from the request: ``--repo`` on GitHub, ``--project`` and
the operator's ``--instance`` on GitLab), its request a number. It runs with
the forge token of the person who starts it, as every run does
(``run_manager`` puts the launcher's stored tokens in its environment):
nothing starts without one. The result is the runner's own file,
``review_<n>.json`` in the clone, which every member of the project reads. A
strict offline policy of the project blocks the job, as it blocks the relay.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project, ProjectJob
from server.forges import gitlab_project
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

MAX_REVIEW = 2_000_000
MAX_NUMBERS = 50
NUMBER_MAX = 10**9
_NUMBERS = re.compile(r"^[1-9][0-9]{0,9}(?:,[1-9][0-9]{0,9}){0,49}$")


class Posted(BaseModel):
    """What the person posted of a review on the forge."""

    model_config = ConfigDict(extra="forbid")

    finding_ids: list[str] = Field(default_factory=list, max_length=500)
    review_id: int | None = Field(default=None, ge=1)


class ReviewJob(BaseModel):
    """What a review job takes; the runner's own choices of thinking level."""

    model_config = ConfigDict(extra="forbid")

    #: The pull request's number, or the merge request's IID.
    number: int = Field(ge=1, le=NUMBER_MAX)
    #: A follow-up of the last review, on what changed since.
    followup: bool = False
    model: str | None = Field(default=None, pattern=MODEL_PATTERN)
    thinking_level: Literal["none", "low", "medium", "high"] | None = None


@dataclass(frozen=True)
class ReviewForge:
    """How one forge's runner reviews a request of the project."""

    #: ``github`` or ``gitlab``: the route, the job and the runner's package.
    forge: str
    #: The forge's name, as the token's refusal says it.
    name: str
    #: The runner's option naming the clone.
    project_flag: str
    #: Where the runner writes a review, relative to the clone.
    review_dir: str
    #: The runner's commands: a review, and a follow-up.
    commands: tuple[str, str]
    #: The runner's options naming the project on the forge, from its record.
    target: Callable[[AsyncSession, ProjectScope], Awaitable[list[str]]]

    @property
    def feature(self) -> str:
        return f"{self.forge}-review"

    @property
    def runner(self) -> str:
        return f"{self.forge}/runner.py"

    def args(self, target: list[str], job: ReviewJob) -> list[str]:
        """The runner's arguments after ``<project_flag> <clone>``."""
        args = list(target)
        if job.model:
            args += ["--model", job.model]
        if job.thinking_level:
            args += ["--thinking-level", job.thinking_level]
        command = self.commands[1] if job.followup else self.commands[0]
        return [*args, command, str(job.number)]


class ForgeReviews:
    """The routes of one forge's reviews, under
    ``/api/features/forge/<forge>/reviews``."""

    def __init__(self, forge: ReviewForge) -> None:
        self.forge = forge
        self.router = APIRouter(
            prefix=f"/api/features/forge/{forge.forge}/reviews", tags=["features"]
        )
        self.router.add_api_route(
            "/jobs", self.start, methods=["POST"], status_code=202
        )
        self.router.add_api_route("/jobs/{job_id}", self.get_job, methods=["GET"])
        self.router.add_api_route(
            "/jobs/{job_id}/cancel", self.cancel_job, methods=["POST"]
        )
        self.router.add_api_route("", self.reviews, methods=["GET"])
        self.router.add_api_route(
            "/{number}/posted", self.mark_posted, methods=["POST"]
        )

    def _slot(self, number: int) -> str:
        # One review of a request at a time; others run beside it.
        return f"{self.forge.feature}:{number}"

    async def start(
        self,
        request: Request,
        body: dict[str, Any] = Body(default_factory=dict),
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        """Review a request of the project, as the caller."""
        principal = get_principal(request)
        _require_writer(scope, principal)
        try:
            job = ReviewJob.model_validate(body)
        except ValueError as e:
            raise HTTPException(status_code=422, detail="Invalid review") from e
        target = await self.forge.target(db, scope)
        guard_offline(scope)
        # The run reads the same token; without one it could only fail later.
        await user_token(db, principal, f"{self.forge.forge}_token", self.forge.name)
        try:
            started = await get_project_jobs().start(
                project_id=scope.project_id,
                org_id=scope.org_id,
                server_path=str(scope.path),
                feature=self.forge.feature,
                runner=self.forge.runner,
                args=self.forge.args(target, job),
                user_id=principal.id,
                slot=self._slot(job.number),
                project_flag=self.forge.project_flag,
            )
        except RunManagerError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        return job_public(started)

    async def _own_job(
        self, db: AsyncSession, scope: ProjectScope, job_id: str
    ) -> ProjectJob:
        job = await db.get(ProjectJob, job_id)
        if (
            job is None
            or job.project_id != scope.project_id
            or job.feature != self.forge.feature
        ):
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    async def get_job(
        self,
        job_id: str,
        after: int = Query(default=0, ge=0),
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, Any]:
        """A review job and the lines of its output after line ``after``."""
        return await job_with_output(
            db, scope, await self._own_job(db, scope, job_id), after
        )

    async def cancel_job(
        self,
        job_id: str,
        request: Request,
        scope: ProjectScope = Depends(resolve_project_scope),
        db: AsyncSession = Depends(get_db),
    ) -> dict[str, bool]:
        _require_writer(scope, get_principal(request))
        job = await self._own_job(db, scope, job_id)
        return {"cancelled": await get_project_jobs().cancel(job.id)}

    def _review_dir(self, scope: ProjectScope) -> Path:
        """The runner's review directory in the clone, refused if a link
        leads it out."""
        root = scope.path.resolve()
        directory = scope.path / self.forge.review_dir
        if directory.exists() and not directory.resolve().is_relative_to(root):
            raise HTTPException(status_code=409, detail="Reviews unavailable")
        return directory

    async def reviews(
        self,
        numbers: str = Query(max_length=11 * MAX_NUMBERS),
        scope: ProjectScope = Depends(resolve_project_scope),
    ) -> dict[str, dict[str, str | None]]:
        """The saved reviews of requests ``numbers`` (comma-separated), as
        the runner wrote them; null for one never reviewed."""
        if not _NUMBERS.match(numbers):
            raise HTTPException(status_code=422, detail="Not request numbers")
        directory = self._review_dir(scope)
        reviews: dict[str, str | None] = {}
        for number in dict.fromkeys(int(n) for n in numbers.split(",")):
            if number > NUMBER_MAX:
                continue
            reviews[str(number)] = read_file(
                directory, f"review_{number}.json", MAX_REVIEW
            )
        return {"reviews": reviews}

    async def mark_posted(
        self,
        number: int,
        request: Request,
        body: Posted,
        scope: ProjectScope = Depends(resolve_project_scope),
    ) -> dict[str, bool]:
        """Record on the saved review what the person posted of it on the
        forge, as the app does in a local project's file: the follow-up
        review starts from it."""
        _require_writer(scope, get_principal(request))
        if not 1 <= number <= NUMBER_MAX:
            raise HTTPException(status_code=422, detail="Not a request number")
        if any(len(i) > 200 for i in body.finding_ids):
            raise HTTPException(status_code=422, detail="Not finding ids")
        if get_project_jobs().running_job(scope.project_id, self._slot(number)):
            raise HTTPException(status_code=409, detail="The review is running")
        directory = self._review_dir(scope)
        # The file written is one the runner saved, named as the directory
        # lists it: nothing of the request goes into the path.
        wanted = f"review_{number}.json"
        name = (
            next(
                (e.name for e in directory.iterdir() if e.name == wanted),
                None,
            )
            if directory.is_dir()
            else None
        )
        text = read_file(directory, name, MAX_REVIEW) if name else None
        try:
            data = json.loads(text) if text is not None else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise HTTPException(status_code=404, detail="No review of this request")
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
        write_json_file(directory, str(name), json.dumps(data, indent=2))
        return {"posted": True}


async def _github_target(db: AsyncSession, scope: ProjectScope) -> list[str]:
    return ["--repo", await project_repo(db, scope)]


async def _gitlab_target(db: AsyncSession, scope: ProjectScope) -> list[str]:
    project = await db.get(Project, scope.project_id)
    found = gitlab_project(project.repo_url) if project else None
    if found is None:
        raise HTTPException(status_code=404, detail="Not a GitLab project")
    host, path = found
    return ["--project", path, "--instance", f"https://{host}"]


GITHUB = ForgeReviews(
    ReviewForge(
        forge="github",
        name="GitHub",
        project_flag="--project",
        review_dir=".workpilot/github/pr",
        commands=("review-pr", "followup-review-pr"),
        target=_github_target,
    )
)
GITLAB = ForgeReviews(
    ReviewForge(
        forge="gitlab",
        name="GitLab",
        project_flag="--project-dir",
        review_dir=".workpilot/gitlab/mr",
        commands=("review-mr", "followup-review-mr"),
        target=_gitlab_target,
    )
)
