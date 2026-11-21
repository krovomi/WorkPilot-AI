"""GitHub-related HTTP endpoints.

Extracted from provider_api.py. Mounted via app.include_router(router).
"""

from __future__ import annotations

import logging
import re
from typing import Annotated
from urllib.parse import urlparse

from fastapi import APIRouter, Query
from foundation.api_safety import safe_error

logger = logging.getLogger(__name__)

router = APIRouter()

# GitHub's own rules: an owner starts with a letter or digit and holds only
# those and hyphens; a repository name holds letters, digits, `.`, `_`, `-`.
# Both reach gh as the value of `-R`, so neither may look like an option.
_OWNER = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")
_REPO = re.compile(r"[A-Za-z0-9._-]{1,100}")
_NUMBER = re.compile(r"[0-9]{1,10}")

_INVALID_URL = {"success": False, "error": "Invalid GitHub PR URL format"}


def _parse_pr_url(pr_url: str) -> tuple[str, int] | None:
    """`owner/repo` and the PR number of a github.com pull request URL."""
    # Expected: https://github.com/<owner>/<repo>/pull/<number>
    parsed = urlparse(pr_url)
    if parsed.netloc != "github.com":
        return None
    path_parts = [p for p in parsed.path.split("/") if p]
    if len(path_parts) < 4 or path_parts[2] != "pull":
        return None
    owner, repo, _, number = path_parts[:4]
    if not (
        _OWNER.fullmatch(owner)
        and _REPO.fullmatch(repo)
        and repo not in (".", "..")
        and _NUMBER.fullmatch(number)
    ):
        return None
    return f"{owner}/{repo}", int(number)


@router.get("/api/github/pr-details")
async def get_pr_details(pr_url: Annotated[str, Query(...)]):
    """Get PR details (files, diffs, metadata) from GitHub."""
    target = _parse_pr_url(pr_url)
    if target is None:
        return _INVALID_URL
    repo, pr_number = target
    try:
        from runners.github.providers.github_provider import GitHubProvider

        pr_data = await GitHubProvider(_repo=repo).fetch_pr(pr_number)

        return {
            "success": True,
            "data": {
                "number": pr_data.number,
                "title": pr_data.title,
                "body": pr_data.body,
                "state": pr_data.state,
                "author": pr_data.author,
                "createdAt": pr_data.created_at.isoformat(),
                "updatedAt": pr_data.updated_at.isoformat(),
                "url": pr_data.url,
                "baseBranch": pr_data.target_branch,
                "headBranch": pr_data.source_branch,
                "mergeable": pr_data.mergeable,
                "additions": pr_data.additions,
                "deletions": pr_data.deletions,
                "changedFiles": pr_data.changed_files,
                "files": pr_data.files,
                "diff": pr_data.diff,
            },
        }
    except Exception as e:
        return {"success": False, "error": safe_error(e, logger, "Operation")}
