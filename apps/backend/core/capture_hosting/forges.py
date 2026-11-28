"""Reading and writing a pull request's body on each forge, and Azure DevOps attachments.

The same credentials as the pull request creation, nothing more:

- GitHub through ``gh api``, GitLab through ``glab api`` (each CLI's own
  sign-in), the body sent as a JSON file (``--input``), never on the command
  line;
- Azure DevOps through its REST API with the PAT or the git credential the
  creation used (`WorktreePRMixin._get_azure_devops_credentials`);
- Bitbucket Cloud through its REST API with `core.bitbucket_pr.auth_headers`.

No call follows a redirect with a credential, and no error text carries one:
a failure is a short code.
"""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

from .refs import PrRef

__all__ = [
    "AZURE_MAX_DESCRIPTION",
    "AzureAttachments",
    "PrBody",
    "body_for",
]

logger = logging.getLogger(__name__)

TIMEOUT = 30
#: Azure DevOps refuses a pull request description longer than this.
AZURE_MAX_DESCRIPTION = 4000
AZURE_ATTACHMENTS_VERSION = "api-version=7.1-preview.1"
ATTACHMENT_PREFIX = "wp-capture-"


class PrBody(Protocol):
    max_chars: int | None

    def read(self) -> str | None: ...

    def write(self, body: str) -> bool: ...


Runner = Callable[[list[str], Path], tuple[int, str]]


def run_cli(args: list[str], cwd: Path) -> tuple[int, str]:
    try:
        done = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return -1, ""
    return done.returncode, done.stdout or ""


class _CliBody:
    """GitHub (``gh``) or GitLab (``glab``): one API path, one body field."""

    max_chars: int | None = None

    def __init__(
        self,
        executable: str,
        host: str,
        default_host: str,
        path: str,
        field: str,
        method: str,
        cwd: Path,
        run: Runner,
    ):
        self._base = [executable, "api"]
        if host != default_host:
            self._base += ["--hostname", host]
        self._path, self._field, self._method = path, field, method
        self._cwd, self._run = cwd, run

    def read(self) -> str | None:
        code, out = self._run([*self._base, self._path], self._cwd)
        if code != 0:
            return None
        try:
            data = json.loads(out)
        except ValueError:
            return None
        value = data.get(self._field) if isinstance(data, dict) else None
        return value if isinstance(value, str) else "" if value is None else None

    def write(self, body: str) -> bool:
        with tempfile.TemporaryDirectory(prefix="wp-pr-body-") as tmp:
            payload = Path(tmp) / "body.json"
            payload.write_text(json.dumps({self._field: body}), encoding="utf-8")
            code, _ = self._run(
                [
                    *self._base,
                    "--method",
                    self._method,
                    "--header",
                    "Content-Type: application/json",
                    self._path,
                    "--input",
                    str(payload),
                ],
                self._cwd,
            )
        return code == 0


class _RestBody:
    """Azure DevOps and Bitbucket: GET then PATCH / PUT one JSON resource."""

    def __init__(
        self,
        url: str,
        field: str,
        method: str,
        session: Any,
        *,
        auth: Any = None,
        headers: Mapping[str, str] | None = None,
        max_chars: int | None = None,
        keep: tuple[str, ...] = (),
    ):
        self._url, self._field, self._method = url, field, method
        self._session, self._auth = session, auth
        self._headers = dict(headers or {})
        self.max_chars = max_chars
        self._keep = keep
        self._kept: dict = {}

    def _call(self, method: str, **kwargs):
        return self._session.request(
            method,
            self._url,
            auth=self._auth,
            headers=self._headers,
            timeout=TIMEOUT,
            allow_redirects=False,
            **kwargs,
        )

    def read(self) -> str | None:
        try:
            resp = self._call("GET")
            if resp.status_code != 200:
                return None
            data = resp.json()
        except (OSError, ValueError) as exc:
            logger.debug("pr body read failed: %s", type(exc).__name__)
            return None
        if not isinstance(data, dict):
            return None
        self._kept = {k: data[k] for k in self._keep if k in data}
        value = data.get(self._field)
        return value if isinstance(value, str) else ""

    def write(self, body: str) -> bool:
        try:
            resp = self._call(self._method, json={**self._kept, self._field: body})
        except OSError as exc:
            logger.debug("pr body write failed: %s", type(exc).__name__)
            return False
        return 200 <= resp.status_code < 300


def _azure_api(ref: PrRef) -> str:
    org, _, project = ref.owner.partition("/")
    return (
        f"https://dev.azure.com/{org}/{project}/_apis/git/repositories/"
        f"{ref.repo}/pullRequests/{ref.number}"
    )


def body_for(
    ref: PrRef,
    cwd: Path,
    *,
    gh: str | None = None,
    glab: str | None = None,
    azure_auth: tuple[str, str] | None = None,
    bitbucket_headers: Mapping[str, str] | None = None,
    session: Any = None,
    run: Runner = run_cli,
) -> PrBody | None:
    """The body of `ref` on its forge, or None without the credential it needs."""
    if ref.provider == "github" and gh:
        return _CliBody(
            gh,
            ref.host,
            "github.com",
            f"repos/{ref.owner}/{ref.repo}/pulls/{ref.number}",
            "body",
            "PATCH",
            cwd,
            run,
        )
    if ref.provider == "gitlab" and glab:
        project = quote(ref.project_path, safe="")
        return _CliBody(
            glab,
            ref.host,
            "gitlab.com",
            f"projects/{project}/merge_requests/{ref.number}",
            "description",
            "PUT",
            cwd,
            run,
        )
    if session is None:
        return None
    if ref.provider == "azure_devops" and azure_auth:
        return _RestBody(
            f"{_azure_api(ref)}?api-version=7.1",
            "description",
            "PATCH",
            session,
            auth=azure_auth,
            max_chars=AZURE_MAX_DESCRIPTION,
        )
    if ref.provider == "bitbucket" and bitbucket_headers:
        return _RestBody(
            f"https://api.bitbucket.org/2.0/repositories/{ref.owner}/{ref.repo}"
            f"/pullrequests/{ref.number}",
            "description",
            "PUT",
            session,
            headers=bitbucket_headers,
            keep=("title",),
        )
    return None


class AzureAttachments:
    """The images of one Azure DevOps pull request, as its own attachments."""

    def __init__(self, ref: PrRef, auth: tuple[str, str], session: Any):
        self._base = f"{_azure_api(ref)}/attachments"
        self._auth, self._session = auth, session

    def _url(self, name: str = "") -> str:
        suffix = f"/{quote(name, safe='')}" if name else ""
        return f"{self._base}{suffix}?{AZURE_ATTACHMENTS_VERSION}"

    def url_of(self, name: str) -> str:
        """The address of an attachment already on the pull request."""
        return f"{self._base}/{quote(name, safe='')}"

    def names(self) -> list[str] | None:
        """Our attachments on the pull request, None when they cannot be listed."""
        try:
            resp = self._session.get(
                self._url(), auth=self._auth, timeout=TIMEOUT, allow_redirects=False
            )
            if resp.status_code != 200:
                return None
            rows = resp.json().get("value") or []
        except (OSError, ValueError, AttributeError):
            return None
        return [
            str(row.get("displayName"))
            for row in rows
            if isinstance(row, dict)
            and str(row.get("displayName") or "").startswith(ATTACHMENT_PREFIX)
        ]

    def upload(self, name: str, local: Path) -> str | None:
        try:
            resp = self._session.post(
                self._url(name),
                data=local.read_bytes(),
                auth=self._auth,
                headers={"Content-Type": "application/octet-stream"},
                timeout=TIMEOUT,
                allow_redirects=False,
            )
            if resp.status_code not in (200, 201):
                return None
            url = resp.json().get("url")
        except (OSError, ValueError, AttributeError):
            return None
        return url if isinstance(url, str) and url.startswith("https://") else None

    def delete(self, name: str) -> bool:
        try:
            resp = self._session.delete(
                self._url(name), auth=self._auth, timeout=TIMEOUT, allow_redirects=False
            )
        except OSError:
            return False
        return resp.status_code in (200, 204, 404)
