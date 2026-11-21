"""
GitLab API Client
=================

Client for GitLab API operations.
Uses direct API calls with PRIVATE-TOKEN authentication.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any


@dataclass
class GitLabConfig:
    """GitLab configuration loaded from project."""

    token: str
    project: str
    instance_url: str


def encode_project_path(project: str) -> str:
    """URL-encode a project path for API calls."""
    return urllib.parse.quote(project, safe="")


# Valid GitLab API endpoint patterns
VALID_ENDPOINT_PATTERNS = (
    "/projects/",
    "/user",
    "/users/",
    "/groups/",
    "/merge_requests/",
    "/issues/",
)


def validate_endpoint(endpoint: str) -> None:
    """
    Validate that an endpoint is a legitimate GitLab API path.
    Raises ValueError if the endpoint is suspicious.
    """
    if not endpoint:
        raise ValueError("Endpoint cannot be empty")

    # Must start with /
    if not endpoint.startswith("/"):
        raise ValueError("Endpoint must start with /")

    # Check for path traversal attempts
    if ".." in endpoint:
        raise ValueError("Endpoint contains path traversal sequence")

    # Check for null bytes
    if "\x00" in endpoint:
        raise ValueError("Endpoint contains null byte")

    # Validate against known patterns
    if not any(endpoint.startswith(pattern) for pattern in VALID_ENDPOINT_PATTERNS):
        raise ValueError(
            f"Endpoint does not match known GitLab API patterns: {endpoint}"
        )


class GitLabAPIError(Exception):
    """A GitLab request that failed.

    ``status`` is the HTTP status GitLab answered with, or ``None`` when the
    instance could not be reached at all.
    """

    def __init__(self, status: int | None, message: str):
        super().__init__(message)
        self.status = status


def _retry_wait(retry_after: str | None, attempt: int) -> int:
    """Seconds to wait before retrying a rate-limited request.

    ``Retry-After`` is either whole seconds or an HTTP date; without a usable
    one the wait doubles with each attempt (1s, 2s, 4s).
    """
    if retry_after:
        try:
            return max(0, int(retry_after))
        except ValueError:
            try:
                retry_date = parsedate_to_datetime(retry_after)
                delta = (retry_date - datetime.now(UTC)).total_seconds()
                return max(1, int(delta))
            except (ValueError, TypeError):
                pass
    return 2**attempt


class GitLabClient:
    """Client for GitLab API operations."""

    def __init__(
        self,
        project_dir: Path,
        config: GitLabConfig,
        default_timeout: float = 30.0,
    ):
        self.project_dir = Path(project_dir)
        self.config = config
        self.default_timeout = default_timeout

    def _api_url(self, endpoint: str) -> str:
        """Build full API URL."""
        base = self.config.instance_url.rstrip("/")
        return f"{base}/api/v4{endpoint}"

    def _fetch(
        self,
        endpoint: str,
        method: str = "GET",
        data: dict | None = None,
        timeout: float | None = None,
        max_retries: int = 3,
    ) -> Any:
        """Make an API request to GitLab with rate limit handling."""
        validate_endpoint(endpoint)
        url = self._api_url(endpoint)
        headers = {
            "PRIVATE-TOKEN": self.config.token,
            "Content-Type": "application/json",
        }

        request_data = None
        if data:
            request_data = json.dumps(data).encode("utf-8")

        attempts = max(1, max_retries)
        attempt = 0
        while True:
            req = urllib.request.Request(
                url,
                data=request_data,
                headers=headers,
                method=method,
            )

            try:
                with urllib.request.urlopen(
                    req, timeout=timeout or self.default_timeout
                ) as response:
                    if response.status == 204:
                        return None
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                error_body = e.read().decode("utf-8", errors="replace")

                # Rate limited (429): wait, then try again while attempts remain
                if e.code == 429 and attempt < attempts - 1:
                    wait_time = _retry_wait(e.headers.get("Retry-After"), attempt)
                    print(
                        f"[GitLab] Rate limited (429). Retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{attempts})...",
                        flush=True,
                    )
                    time.sleep(wait_time)
                    attempt += 1
                    continue

                raise GitLabAPIError(
                    e.code, f"GitLab API error {e.code}: {error_body}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                reason = getattr(e, "reason", e)
                raise GitLabAPIError(
                    None,
                    f"Could not reach GitLab at {self.config.instance_url}: {reason}",
                ) from e

    def get_mr(self, mr_iid: int) -> dict:
        """Get MR details."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(f"/projects/{encoded_project}/merge_requests/{mr_iid}")

    def get_mr_changes(self, mr_iid: int) -> dict:
        """Get MR changes (diff)."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}/changes"
        )

    def get_mr_diff(self, mr_iid: int) -> str:
        """Get the full diff for an MR."""
        changes = self.get_mr_changes(mr_iid)
        diffs = []
        for change in changes.get("changes", []):
            diff = change.get("diff", "")
            if diff:
                diffs.append(diff)
        return "\n".join(diffs)

    def get_mr_commits(self, mr_iid: int) -> list[dict]:
        """Get commits for an MR."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}/commits"
        )

    def get_current_user(self) -> dict:
        """Get current authenticated user."""
        return self._fetch("/user")

    def post_mr_note(self, mr_iid: int, body: str) -> dict:
        """Post a note (comment) to an MR."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}/notes",
            method="POST",
            data={"body": body},
        )

    def approve_mr(self, mr_iid: int) -> dict:
        """Approve an MR."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}/approve",
            method="POST",
        )

    def merge_mr(self, mr_iid: int, squash: bool = False) -> dict:
        """Merge an MR."""
        encoded_project = encode_project_path(self.config.project)
        data = {}
        if squash:
            data["squash"] = True
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}/merge",
            method="PUT",
            data=data if data else None,
        )

    def assign_mr(self, mr_iid: int, user_ids: list[int]) -> dict:
        """Assign users to an MR."""
        encoded_project = encode_project_path(self.config.project)
        return self._fetch(
            f"/projects/{encoded_project}/merge_requests/{mr_iid}",
            method="PUT",
            data={"assignee_ids": user_ids},
        )


def load_gitlab_config(project_dir: Path) -> GitLabConfig | None:
    """Load GitLab config from project's .workpilot/gitlab/config.json."""
    config_path = project_dir / ".workpilot" / "gitlab" / "config.json"

    if not config_path.exists():
        return None

    try:
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)

        token = data.get("token")
        project = data.get("project")
        instance_url = data.get("instance_url", "https://gitlab.com")

        if not token or not project:
            return None

        return GitLabConfig(
            token=token,
            project=project,
            instance_url=instance_url,
        )
    except Exception:
        return None
