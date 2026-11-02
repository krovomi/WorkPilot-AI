"""The forge a rule reads, as the person who saved the rule.

A server project is on GitHub or on a GitLab instance the operator named
(``server.forges``). The rule reads it with the token its owner stored on the
server (``server.services.secrets``), as the forge views do for that person:
the token goes in a header to the forge's API and nowhere else, never in a
log, an error or an answer. Every URL is built here from the project's own
record and the source's fixed paths, never from what the forge answered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException
from shared_features.forge import GITHUB_API, send

from .sources import SourceError


@dataclass(frozen=True)
class ForgeApi:
    """One project on one forge, read with one person's token."""

    #: ``github`` or ``gitlab``.
    forge: str
    #: ``owner/repo`` on GitHub; ``host/group/project`` on GitLab: the dedup keys'.
    slug: str
    #: The project's API root, ``…/repos/<owner>/<repo>`` or ``…/projects/<id>``.
    root: str
    #: The forge's ``/user``.
    user_url: str
    #: Never in a repr, a log or an error.
    token: str = field(repr=False)

    @property
    def name(self) -> str:
        return "GitHub" if self.forge == "github" else "GitLab"

    def _headers(self) -> dict[str, str]:
        if self.forge == "github":
            return {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "User-Agent": "WorkPilot-AI",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        return {"PRIVATE-TOKEN": self.token, "User-Agent": "WorkPilot-AI"}

    async def _get(self, url: str, params: dict[str, str] | None) -> Any:
        try:
            answer = await send("GET", url, self._headers(), params=params)
        except HTTPException as e:
            raise SourceError("source_failed", f"{self.name}: {e.detail}") from None
        status = answer.get("status", 0)
        if not 200 <= status < 300:
            raise SourceError("source_failed", f"{self.name} answered {status}")
        return answer.get("body")

    async def get(self, path: str, params: dict[str, str] | None = None) -> Any:
        """``path`` below the project's API root, a fixed path of the sources."""
        return await self._get(self.root + path, params)

    async def me(self) -> str:
        """Whose token this is: the login, lowercased; fails when unsaid."""
        body = await self._get(self.user_url, None)
        login = (
            body.get("login" if self.forge == "github" else "username")
            if isinstance(body, dict)
            else None
        )
        if not isinstance(login, str) or not login:
            raise SourceError(
                "source_failed", f"{self.name} did not say whose token this is"
            )
        return login.lower()


def github_api(repo: str, token: str) -> ForgeApi:
    return ForgeApi(
        forge="github",
        slug=repo,
        root=f"{GITHUB_API}/repos/{repo}",
        user_url=f"{GITHUB_API}/user",
        token=token,
    )


def gitlab_api(host: str, path: str, token: str) -> ForgeApi:
    base = f"https://{host}/api/v4"
    return ForgeApi(
        forge="gitlab",
        slug=f"{host}/{path}",
        root=f"{base}/projects/{quote(path, safe='')}",
        user_url=f"{base}/user",
        token=token,
    )
