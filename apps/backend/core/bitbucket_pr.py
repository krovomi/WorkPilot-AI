"""Bitbucket Cloud pull requests for a task's worktree branch.

`WorktreeManager.push_and_create_pr` pushes the branch, then calls
`create_bitbucket_pull_request` when the pushed remote is on bitbucket.org
(`foundation.git_provider`). The REST API (https://api.bitbucket.org/2.0) is
called directly, without a shell or a CLI. The credentials come only from the
process environment, which the desktop app builds from the project's
`.workpilot/.env` (`BITBUCKET_TOKEN` is stored encrypted there, so it is never
read from the file): ``BITBUCKET_USERNAME`` + ``BITBUCKET_TOKEN`` is HTTP Basic
(API token or app password), ``BITBUCKET_TOKEN`` alone is a Bearer access token.
The token never enters a URL, a log or an error message.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from core.pr_group import append_section
from core.worktree_common import PullRequestResult
from foundation.git_executable import run_git

if TYPE_CHECKING:
    from core.worktree_pr import WorktreePRMixin

logger = logging.getLogger(__name__)

API_BASE = "https://api.bitbucket.org/2.0"
TIMEOUT_SECONDS = 30
_SLUG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
_MAX_ERROR_TEXT = 300
_MAX_CREDENTIAL = 1024


def _is_slug(value: str) -> bool:
    return bool(_SLUG.match(value)) and value.strip(".") != ""


def _is_bitbucket_host(host: str) -> bool:
    host = host.lower()
    return host == "bitbucket.org" or host.endswith(".bitbucket.org")


def repo_from_remote(url: str) -> tuple[str, str] | None:
    """``(workspace, repo)`` of a bitbucket.org remote, else None.

    Reads ``https://[user@]bitbucket.org/ws/repo[.git]``,
    ``git@bitbucket.org:ws/repo.git`` and ``ssh://git@host[:port]/ws/repo.git``;
    a host merely containing "bitbucket.org" is not Bitbucket.
    """
    match = re.match(
        r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^@/]+@)?([^/:]+)(?::\d+(?=/))?[:/](.+)$",
        url.strip(),
        re.IGNORECASE,
    )
    if not match or not _is_bitbucket_host(match.group(1)):
        return None
    path = re.sub(r"[?#].*$", "", match.group(2)).strip("/")
    path = re.sub(r"\.git$", "", path)
    parts = path.split("/")
    if len(parts) != 2 or not all(_is_slug(part) for part in parts):
        return None
    return parts[0], parts[1]


def _credential(value: str | None) -> str | None:
    if not value:
        return None
    kept = "".join(ch for ch in value if ord(ch) > 0x1F and ord(ch) != 0x7F).strip()
    return kept if kept and len(kept) <= _MAX_CREDENTIAL else None


def auth_headers(env: Mapping[str, str] | None = None) -> dict[str, str] | None:
    """The Authorization header the environment's credentials make, or None."""
    env = os.environ if env is None else env
    token = _credential(env.get("BITBUCKET_TOKEN"))
    if not token:
        return None
    username = _credential(env.get("BITBUCKET_USERNAME"))
    if username:
        basic = base64.b64encode(f"{username}:{token}".encode()).decode("ascii")
        return {"Authorization": f"Basic {basic}", "Accept": "application/json"}
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def resolve_repo(
    project_dir: str | Path,
    remote: str | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[str, str] | None:
    """The repository the pushed remote names, else the project's settings."""
    result = run_git(
        ["remote", "get-url", remote or "origin"], cwd=project_dir, timeout=5
    )
    if result.returncode == 0:
        ref = repo_from_remote(result.stdout.strip())
        if ref:
            return ref
    env = os.environ if env is None else env
    return repo_from_settings(
        (env.get("BITBUCKET_WORKSPACE") or "").strip(),
        (env.get("BITBUCKET_REPO") or "").strip(),
    )


def repo_from_settings(workspace: str, repo: str) -> tuple[str, str] | None:
    """The repository the settings name: a slug beside its workspace, ``ws/repo`` or a clone URL."""
    if "://" in repo or "@" in repo:
        return repo_from_remote(repo)
    if "/" in repo:
        workspace, _, repo = repo.removesuffix(".git").partition("/")
    return (workspace, repo) if _is_slug(workspace) and _is_slug(repo) else None


def _repo_url(workspace: str, repo: str) -> str:
    return f"{API_BASE}/repositories/{quote(workspace, safe='')}/{quote(repo, safe='')}"


def _web_url(data: Any) -> str | None:
    href = (((data or {}).get("links") or {}).get("html") or {}).get("href")
    if isinstance(href, str) and href.startswith("https://bitbucket.org/"):
        return href
    return None


def _error_text(resp: Any) -> str:
    try:
        message = (resp.json().get("error") or {}).get("message")
    except ValueError:
        message = None
    text = message if isinstance(message, str) else resp.reason or ""
    return str(text)[:_MAX_ERROR_TEXT]


def find_open_pull_request(
    workspace: str, repo: str, source: str, target: str, headers: dict[str, str]
) -> str | None:
    """The web URL of an open pull request from ``source`` to ``target``, if any."""
    import requests

    query = (
        f'source.branch.name="{source}" AND destination.branch.name="{target}" '
        'AND state="OPEN"'
    )
    resp = requests.get(
        f"{_repo_url(workspace, repo)}/pullrequests",
        params={"q": query, "pagelen": 1},
        headers=headers,
        timeout=TIMEOUT_SECONDS,
        allow_redirects=False,
    )
    if resp.status_code != 200:
        return None
    values = resp.json().get("values") or []
    return _web_url(values[0]) if values else None


def _branch_ok(name: str) -> bool:
    """A branch name that cannot break out of the query's quotes."""
    return bool(name) and '"' not in name and "\\" not in name and len(name) <= 255


def _pr_body(
    manager: WorktreePRMixin,
    spec_name: str,
    target: str,
    branch: str,
    body: str | None,
    body_suffix: str,
) -> str:
    """The caller's body, else the generated one with its impact block (as for Azure DevOps)."""
    if body is not None:
        return append_section(body, body_suffix)
    diff_summary = commit_log = ""
    generated: str | None = None
    try:
        diff_summary, commit_log = manager._gather_pr_context(spec_name, target)
        generated = manager._try_ai_pr_body(
            spec_name=spec_name,
            target_branch=target,
            branch_name=branch,
            diff_summary=diff_summary,
            commit_log=commit_log,
        )
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
        logger.warning(f"AI PR body generation encountered an error: {e}")
    text = generated or manager._extract_spec_summary(spec_name)
    text = manager._inject_impact_block(
        spec_name=spec_name, body=text, diff_summary=diff_summary, commit_log=commit_log
    )
    return append_section(text, body_suffix)


def create_bitbucket_pull_request(
    manager: WorktreePRMixin,
    spec_name: str,
    target_branch: str | None = None,
    title: str | None = None,
    draft: bool = False,
    body: str | None = None,
    body_suffix: str = "",
    remote: str | None = None,
) -> PullRequestResult:
    """Open (or find) the pull request of a spec's branch on Bitbucket Cloud."""
    import requests

    info = manager.get_worktree_info(spec_name)
    if not info:
        return PullRequestResult(
            success=False, error=f"No worktree found for spec: {spec_name}"
        )
    target = target_branch or manager.base_branch
    if not _branch_ok(info.branch) or not _branch_ok(target):
        return PullRequestResult(
            success=False, error="Invalid branch name for a Bitbucket pull request"
        )

    ref = resolve_repo(manager.project_dir, remote)
    if not ref:
        return PullRequestResult(
            success=False,
            error="Could not determine the Bitbucket workspace and repository from the git remote",
        )
    headers = auth_headers()
    if not headers:
        return PullRequestResult(
            success=False,
            error="No Bitbucket credentials. Set the token in the project's Bitbucket settings.",
        )
    workspace, repo = ref

    try:
        existing = find_open_pull_request(workspace, repo, info.branch, target, headers)
        if existing:
            return PullRequestResult(success=True, pr_url=existing, already_exists=True)
        payload = {
            "title": (title or f"feat: {spec_name}")[:255],
            "description": _pr_body(
                manager, spec_name, target, info.branch, body, body_suffix
            ),
            "source": {"branch": {"name": info.branch}},
            "destination": {"branch": {"name": target}},
            "close_source_branch": False,
            "draft": bool(draft),
        }
        resp = requests.post(
            f"{_repo_url(workspace, repo)}/pullrequests",
            json=payload,
            headers={**headers, "Content-Type": "application/json"},
            timeout=TIMEOUT_SECONDS,
            allow_redirects=False,
        )
    except requests.RequestException:
        return PullRequestResult(success=False, error="Bitbucket API unreachable")

    if resp.status_code in (200, 201):
        return PullRequestResult(
            success=True, pr_url=_web_url(resp.json()), already_exists=False
        )
    if resp.status_code in (401, 403):
        return PullRequestResult(
            success=False,
            error=f"Bitbucket refused the credentials (HTTP {resp.status_code}). Check the token's pull request write scope.",
        )
    return PullRequestResult(
        success=False,
        error=f"Bitbucket API error (HTTP {resp.status_code}): {_error_text(resp)}",
    )


def existing_bitbucket_pr_url(
    manager: WorktreePRMixin, spec_name: str, target_branch: str | None = None
) -> str | None:
    """Best-effort: the open pull request of a spec's branch, or None. Never raises."""
    import requests

    try:
        info = manager.get_worktree_info(spec_name)
        target = target_branch or manager.base_branch
        ref = resolve_repo(manager.project_dir)
        headers = auth_headers()
        if not info or not ref or not headers:
            return None
        if not _branch_ok(info.branch) or not _branch_ok(target):
            return None
        return find_open_pull_request(ref[0], ref[1], info.branch, target, headers)
    except (requests.RequestException, ValueError, OSError):
        return None
