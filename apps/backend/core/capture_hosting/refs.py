"""Which pull request a URL names, and where its images can be read.

Each forge's own web URL of a pull request (the one `push_and_create_pr`
returns) carries everything the sync needs: the host, the repository and the
number. A URL that does not have the forge's exact shape names nothing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

__all__ = ["PrRef", "parse_pr_url"]

_SEGMENT = re.compile(r"^[A-Za-z0-9_.%][A-Za-z0-9_.~%-]{0,127}$")
_HOST = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)


@dataclass(frozen=True)
class PrRef:
    provider: str
    host: str
    #: ``owner/repo`` on GitHub and Bitbucket, the namespace path on GitLab,
    #: ``org/project`` on Azure DevOps.
    owner: str
    repo: str
    number: int

    @property
    def project_path(self) -> str:
        return f"{self.owner}/{self.repo}"

    def image_url(self, branch: str, path: str) -> str:
        """The URL a browser signed in to the forge reads a file of `branch` at."""
        file = quote(path, safe="/")
        ref = quote(branch, safe="/")
        base = f"https://{self.host}/{self.project_path}"
        if self.provider == "github":
            return f"{base}/blob/{ref}/{file}?raw=1"
        if self.provider == "gitlab":
            return f"{base}/-/raw/{ref}/{file}"
        if self.provider == "bitbucket":
            return f"{base}/raw/{ref}/{file}"
        raise ValueError(f"no branch images on {self.provider}")


def _segments(path: str) -> list[str] | None:
    parts = [p for p in path.split("/") if p]
    # GitLab separates the project from its pages with a bare "-".
    valid = all(p == "-" or (_SEGMENT.match(p) and p.strip(".")) for p in parts)
    return parts if valid else None


def parse_pr_url(provider: str, url: str | None) -> PrRef | None:
    """The pull request `url` names on `provider`, or None."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not _HOST.match(host) or parts.port or parts.username:
        return None
    segments = _segments(parts.path)
    if not segments or (provider != "gitlab" and "-" in segments):
        return None
    if provider == "github":
        if len(segments) == 4 and segments[2] == "pull" and segments[3].isdigit():
            return PrRef("github", host, segments[0], segments[1], int(segments[3]))
    elif provider == "gitlab":
        if (
            len(segments) >= 5
            and segments[-3:-1] == ["-", "merge_requests"]
            and segments[-1].isdigit()
        ):
            names = segments[:-3]
            return PrRef(
                "gitlab", host, "/".join(names[:-1]), names[-1], int(segments[-1])
            )
    elif provider == "bitbucket":
        if (
            host == "bitbucket.org"
            and len(segments) == 4
            and segments[2] == "pull-requests"
            and segments[3].isdigit()
        ):
            return PrRef("bitbucket", host, segments[0], segments[1], int(segments[3]))
    elif provider == "azure_devops":
        if (
            host == "dev.azure.com"
            and len(segments) == 6
            and segments[2] == "_git"
            and segments[4] == "pullrequest"
            and segments[5].isdigit()
        ):
            return PrRef(
                "azure_devops",
                host,
                f"{segments[0]}/{segments[1]}",
                segments[3],
                int(segments[5]),
            )
    return None
