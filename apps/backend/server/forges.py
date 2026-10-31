"""Which forge a server project is on, read from the URL it was cloned from.

The app shows a project's GitHub or GitLab views from the ``forge`` of its
listing, and the forge relay (``shared_features/forge.py``) calls the API of
that forge with the person's own token. A URL is a GitLab project only
when its host is one the operator named
(``WORKPILOT_GITLAB_HOSTS``, gitlab.com always): the host comes from a
project's ``repo_url``, which a project owner chooses, and a person's GitLab
token must never be sent to a host nobody on the server vouched for.
"""

from __future__ import annotations

import re

from server.config import get_settings

#: ``owner/repo`` from a github.com URL.
_GITHUB_URL = re.compile(
    r"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)"
    r"(?P<repo>[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$"
)
#: ``host`` and ``group/…/project`` from a GitLab URL (https or ssh).
_GITLAB_URL = re.compile(
    r"^(?:https://(?:[^@/]+@)?(?P<https_host>[A-Za-z0-9.-]{1,253})/"
    r"|git@(?P<scp_host>[A-Za-z0-9.-]{1,253}):"
    r"|ssh://git@(?P<ssh_host>[A-Za-z0-9.-]{1,253})(?::\d{1,5})?/)"
    r"(?P<path>[A-Za-z0-9_.-]{1,255}(?:/[A-Za-z0-9_.-]{1,255}){1,19})/?$"
)


def github_repo(repo_url: str) -> str | None:
    """``owner/repo`` of a github.com URL, else None."""
    match = _GITHUB_URL.match((repo_url or "").strip())
    return match.group("repo") if match else None


def gitlab_project(repo_url: str) -> tuple[str, str] | None:
    """The GitLab host, as the operator wrote it, and the project's path, when
    the URL is on one of the server's GitLab hosts; else None."""
    match = _GITLAB_URL.match((repo_url or "").strip())
    if not match:
        return None
    host = (
        match.group("https_host") or match.group("scp_host") or match.group("ssh_host")
    ).lower()
    path = match.group("path").removesuffix(".git")
    if any(part in ("", ".", "..") for part in path.split("/")):
        return None
    for allowed in get_settings().gitlab_hosts:
        if allowed == host:
            return allowed, path
    return None


def forge_of(repo_url: str) -> str | None:
    """``github``, ``gitlab`` or None."""
    if github_repo(repo_url):
        return "github"
    if gitlab_project(repo_url):
        return "gitlab"
    return None
