"""The changelog of a server project: what the view reads before it asks for one.

The changelog itself is built by a job on the clone and saved as the
project's shared report, like an analysis (``shared_features.analyses``,
kind ``changelog``: ``POST /api/features/analyses/changelog/jobs``,
``GET /api/features/analyses/changelog/report``). The view also needs the
clone's branches, tags and commits to choose what goes in, and the last
version its ``CHANGELOG.md`` names; a member may correct the shared
changelog once it is built. Those routes are here, all by ``project_id``:

| Route | Permission |
|---|---|
| ``GET /api/features/changelog/sources`` | ``insight.read`` |
| ``GET /api/features/changelog/commits`` | ``insight.read`` |
| ``PUT /api/features/changelog/report`` | ``insight.write``, role ``member`` or more |

No route takes a path or a git argument: references are checked by
``changelog_generator.options`` and git runs with an argument list.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any, Literal

from changelog_generator import git_history
from changelog_generator.options import BranchDiff, GitHistory
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.services.project_jobs import get_project_jobs
from shared_board.cards import _require_writer
from shared_features.analyses import (
    MAX_REPORT,
    _report_dir,
    analysis_named,
)
from shared_features.api import read_file, write_json_file

router = APIRouter(prefix="/api/features/changelog", tags=["features"])

#: The longest changelog a member may save.
MAX_CHANGELOG = 1_000_000


@router.get("/sources")
async def get_sources(
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The clone's branches and tags, and its existing ``CHANGELOG.md``."""
    clone = scope.path

    def read() -> dict[str, Any]:
        return {
            "branches": git_history.branches(clone),
            "tags": git_history.tags(clone),
            "currentBranch": git_history.current_branch(clone),
            "defaultBranch": git_history.default_branch(clone),
            "existing": git_history.existing_changelog(clone),
        }

    return await asyncio.to_thread(read)


@router.get("/commits")
async def get_commits(
    mode: Literal["git-history", "branch-diff"] = Query(),
    kind: str = Query(default="recent", alias="type"),
    count: int = Query(default=25),
    since_date: str | None = Query(default=None),
    from_tag: str | None = Query(default=None),
    to_tag: str | None = Query(default=None),
    include_merge_commits: bool = Query(default=False),
    base_branch: str | None = Query(default=None),
    compare_branch: str | None = Query(default=None),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The commits a changelog of this range would be built from."""
    try:
        if mode == "branch-diff":
            diff = BranchDiff(
                base_branch=base_branch or "", compare_branch=compare_branch or ""
            )
        else:
            history = GitHistory.model_validate(
                {
                    "type": kind,
                    "count": count,
                    "since_date": since_date,
                    "from_tag": from_tag,
                    "to_tag": to_tag,
                    "include_merge_commits": include_merge_commits,
                }
            )
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Invalid range") from e
    clone = scope.path
    commits = await asyncio.to_thread(
        lambda: (
            git_history.branch_diff_commits(clone, diff)
            if mode == "branch-diff"
            else git_history.history_commits(clone, history)
        )
    )
    return {"commits": [commit.to_json() for commit in commits]}


class ChangelogEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changelog: str = Field(min_length=1, max_length=MAX_CHANGELOG)


@router.put("/report")
async def save_report(
    request: Request,
    body: ChangelogEdit = Body(),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, bool]:
    """Replace the text of the shared changelog with a member's correction."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    analysis = analysis_named("changelog")
    if get_project_jobs().running_job(scope.project_id, analysis.feature):
        raise HTTPException(
            status_code=409, detail="A changelog is being built; try again after it"
        )
    directory = _report_dir(scope.path)
    if directory is None:
        raise HTTPException(status_code=409, detail="Reports unavailable")
    text = read_file(directory, analysis.report_file, MAX_REPORT)
    try:
        saved = json.loads(text) if text else None
    except ValueError:
        saved = None
    if not isinstance(saved, dict) or not isinstance(saved.get("report"), dict):
        raise HTTPException(status_code=404, detail="No changelog to correct")
    saved["report"]["changelog"] = body.changelog
    saved["edited_by"] = principal.id
    saved["edited_at"] = datetime.now(UTC).isoformat()
    write_json_file(directory, analysis.report_file, json.dumps(saved))
    return {"saved": True}
