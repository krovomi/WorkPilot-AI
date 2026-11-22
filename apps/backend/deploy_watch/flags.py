"""Turn the release's feature flag off instead of redeploying (#366, lot 4).

The issue's intelligent rollback chooses between reverting the commit,
redeploying the last good run and turning a feature flag off. When the
project's CI/CD settings name the flag that guards what was deployed, a
critical verdict turns it off first: the code stays, its path is closed, and
a database migration does not stand in the way since the schema is not
touched. Only when the flag cannot be switched does the watch fall back to
the deployment rollback.

Everything comes from the CI/CD settings, never from a file of the
repository: the provider (closed list), its URL (https, or http to the
machine; LaunchDarkly and ConfigCat default to their own hosts), the token,
the flag, its project and environment (patterns). The requests are those of
the Release Train's flags (`release_coordinator/flags.py`), sent through the
watch's bounded fetch: 10 s, no redirect, nothing read but the status.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import quote, urlsplit

from .collectors import Fetch
from .config import is_local_host, valid_url

PROVIDERS = ("unleash", "launchdarkly", "configcat")
DEFAULT_URLS = {
    "launchdarkly": "https://app.launchdarkly.com",
    "configcat": "https://api.configcat.com",
}
_KEY = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


@dataclass(frozen=True)
class RollbackFlag:
    """The flag of the settings; the credentials never show in a repr."""

    provider: str
    key: str
    environment: str
    url: str
    project: str = ""
    token: str = field(default="", repr=False)
    user: str = field(default="", repr=False)

    @property
    def local(self) -> bool:
        return is_local_host(self.url)


def flag_from_env(env: dict, problems: list[str]) -> RollbackFlag | None:
    """The flag the CI/CD settings name, or None (a refused one is named)."""
    provider = str(env.get("CICD_ROLLBACK_FLAG_PROVIDER") or "").strip().lower()
    if not provider:
        return None
    if provider not in PROVIDERS:
        problems.append(
            "CICD_ROLLBACK_FLAG_PROVIDER: unleash, launchdarkly or configcat"
        )
        return None
    key = str(env.get("CICD_ROLLBACK_FLAG_KEY") or "").strip()
    environment = str(env.get("CICD_ROLLBACK_FLAG_ENVIRONMENT") or "").strip()
    project = str(env.get("CICD_ROLLBACK_FLAG_PROJECT") or "").strip()
    url = str(env.get("CICD_ROLLBACK_FLAG_URL") or "").strip().rstrip(
        "/"
    ) or DEFAULT_URLS.get(provider, "")
    token = str(env.get("CICD_ROLLBACK_FLAG_TOKEN") or "")
    if not (_KEY.match(key) and _NAME.match(environment)):
        problems.append("rollback flag: the key and the environment are required")
        return None
    if project and not _NAME.match(project):
        problems.append("CICD_ROLLBACK_FLAG_PROJECT: not a project key")
        return None
    if not (valid_url(url) and (urlsplit(url).scheme == "https" or is_local_host(url))):
        problems.append("CICD_ROLLBACK_FLAG_URL: https, or http to this machine")
        return None
    needs_project = provider == "launchdarkly" or (
        provider == "configcat" and not key.isdigit()
    )
    if not token or (needs_project and not project):
        problems.append(f"rollback flag: {provider} needs its token and project")
        return None
    return RollbackFlag(
        provider,
        key,
        environment,
        url,
        project,
        token=token,
        user=str(env.get("CICD_ROLLBACK_FLAG_USER") or ""),
    )


def _request(flag: RollbackFlag) -> urllib.request.Request:
    """The call that turns `flag` off."""
    headers = {"User-Agent": "WorkPilot", "Content-Type": "application/json"}
    if flag.provider == "unleash":
        project = flag.project or "default"
        url = (
            f"{flag.url}/api/admin/projects/{quote(project, safe='')}/features/"
            f"{quote(flag.key, safe='')}/environments/{quote(flag.environment, safe='')}/off"
        )
        headers["Authorization"] = flag.token
        return urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
    if flag.provider == "launchdarkly":
        body = {
            "environmentKey": flag.environment,
            "comment": "WorkPilot deployment watch: critical verdict",
            "instructions": [{"kind": "turnFlagOff"}],
        }
        headers["Authorization"] = flag.token
        headers["Content-Type"] = (
            "application/json; domain-model=launchdarkly.semanticpatch"
        )
        url = f"{flag.url}/api/v2/flags/{quote(flag.project, safe='')}/{quote(flag.key, safe='')}"
        return urllib.request.Request(
            url, data=json.dumps(body).encode(), headers=headers, method="PATCH"
        )
    query = "" if flag.key.isdigit() else f"?configId={quote(flag.project, safe='')}"
    credentials = base64.b64encode(f"{flag.user}:{flag.token}".encode()).decode()
    headers["Authorization"] = f"Basic {credentials}"
    url = (
        f"{flag.url}/v1/environments/{quote(flag.environment, safe='')}/settings/"
        f"{quote(flag.key, safe='')}/value{query}"
    )
    return urllib.request.Request(
        url, data=json.dumps({"value": False}).encode(), headers=headers, method="PUT"
    )


def turn_off(flag: RollbackFlag, fetch: Fetch, *, offline: bool) -> dict:
    """Turn the flag off: `done`, `failed` or `offline`, with what was switched."""
    result = {
        "provider": flag.provider,
        "key": flag.key,
        "environment": flag.environment,
    }
    if offline and not flag.local:
        return {**result, "status": "offline"}
    try:
        status, _body = fetch(_request(flag))
    except (OSError, ValueError):
        return {**result, "status": "failed"}
    return {**result, "status": "done" if 200 <= status < 300 else "failed"}
