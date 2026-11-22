"""Go back to the deployment that worked (#366).

The target is the last run of the configured pipeline that succeeded before
the watched one was triggered. Where the provider's API can run it again on
its own commit, WorkPilot can do the rollback:

* GitHub Actions: `POST /actions/runs/{id}/rerun` re-runs that workflow run,
  on the commit it ran on;
* Azure Pipelines: a new run of the pipeline pinned to that run's commit
  (`resources.repositories.self.version`).

GitLab creates a pipeline only on a branch or a tag, and Jenkins only knows
its job's parameters: for them the plan names the last good pipeline or
build and its link, and the rollback stays manual. Jenkins says which commit
each build checked out when its Git plugin records it (`lastBuiltRevision`):
the plan then carries both commits, for the migration check and the revert
PR. The branch still holds
the bad commit either way: the report says to revert it.

Every request goes to the provider's own API host, with the token of the
project's CI/CD settings, bounded like the collectors.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from urllib.parse import quote, urlencode

from .collectors import default_fetch
from .net import MAX_BODY_BYTES, Fetch, valid_url

_REPO = re.compile(r"^(?!\.{1,2}/)[A-Za-z0-9_.-]+/(?!\.{1,2}$)[A-Za-z0-9_.-]+$")
_NAME = re.compile(r"^[A-Za-z0-9_. -]{1,200}$")
_ID = re.compile(r"^[0-9]{1,12}$")
_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")
_GITHUB_PR = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/\d+"
)


@dataclass
class RollbackPlan:
    provider: str
    # Why the plan is what it is: rerun | redeploy_commit | manual |
    # no_previous_success | not_configured | unreachable | unsupported.
    reason: str
    automatic: bool = False
    target_run: str = ""
    target_sha: str = ""
    target_url: str = ""
    current_sha: str = ""
    # When the target run was created (ISO 8601): the state a coordinated
    # rollback takes the linked services back to.
    target_at: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _when(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _https(value: object) -> str:
    return value if isinstance(value, str) and value.startswith("https://") else ""


def _sha(value: object) -> str:
    return value if isinstance(value, str) and _SHA.match(value) else ""


def _json(
    fetch: Fetch, url: str, headers: dict, method: str = "GET", body: dict | None = None
) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    status, raw = fetch(request)
    if not raw or len(raw) > MAX_BODY_BYTES:
        return status, None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return status, None


def _split(runs: list[dict], triggered: datetime) -> tuple[dict | None, dict | None]:
    """(newest good run before the trigger, earliest run at or after it)."""
    before = [r for r in runs if r["at"] < triggered and r["good"]]
    after = [r for r in runs if r["at"] >= triggered]
    good = max(before, key=lambda r: r["at"]) if before else None
    current = min(after, key=lambda r: r["at"]) if after else None
    return good, current


# ── GitHub Actions ────────────────────────────────────────────────────────────


def _github_context(env: dict, pr_url: str) -> tuple[str, str, dict] | None:
    token = str(env.get("CICD_GITHUB_TOKEN") or "")
    workflow = str(env.get("CICD_GITHUB_WORKFLOW") or "")
    repo = str(env.get("CICD_GITHUB_REPO") or "")
    if not repo and (match := _GITHUB_PR.match(pr_url or "")):
        repo = match.group(1)
    if not (token and _REPO.match(repo) and _NAME.match(workflow)):
        return None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "WorkPilot",
    }
    return repo, workflow, headers


def _github_plan(
    env: dict, run: dict, triggered: datetime, fetch: Fetch
) -> RollbackPlan:
    context = _github_context(env, str(run.get("pr_url") or ""))
    if not context:
        return RollbackPlan("github", "not_configured")
    repo, workflow, headers = context
    url = (
        f"https://api.github.com/repos/{repo}/actions/workflows/{quote(workflow)}/runs?"
        + urlencode({"per_page": 50})
    )
    status, doc = _json(fetch, url, headers)
    items = (
        doc.get("workflow_runs") if status == 200 and isinstance(doc, dict) else None
    )
    if not isinstance(items, list):
        return RollbackPlan("github", "unreachable")
    runs = []
    for item in items:
        at = _when(item.get("created_at")) if isinstance(item, dict) else None
        if at and _ID.match(str(item.get("id"))):
            runs.append(
                {
                    "at": at,
                    "good": item.get("conclusion") == "success",
                    "id": str(item["id"]),
                    "sha": _sha(item.get("head_sha")),
                    "url": _https(item.get("html_url")),
                }
            )
    good, current = _split(runs, triggered)
    if not good:
        return RollbackPlan("github", "no_previous_success")
    return RollbackPlan(
        "github",
        "rerun",
        automatic=True,
        target_run=good["id"],
        target_sha=good["sha"],
        target_url=good["url"],
        target_at=good["at"].isoformat(),
        current_sha=current["sha"] if current else "",
    )


def _github_execute(env: dict, run: dict, plan: RollbackPlan, fetch: Fetch) -> bool:
    context = _github_context(env, str(run.get("pr_url") or ""))
    if not context or not _ID.match(plan.target_run):
        return False
    repo, _workflow, headers = context
    url = f"https://api.github.com/repos/{repo}/actions/runs/{plan.target_run}/rerun"
    status, _ = _json(fetch, url, headers, method="POST", body={})
    return status in (200, 201, 204)


# ── Azure Pipelines ───────────────────────────────────────────────────────────


def _azure_context(env: dict) -> tuple[str, dict] | None:
    token = str(env.get("CICD_AZURE_TOKEN") or "")
    org = str(env.get("CICD_AZURE_ORG") or "")
    project = str(env.get("CICD_AZURE_PROJECT") or "")
    pipeline = str(env.get("CICD_AZURE_PIPELINE_ID") or "")
    if not (
        token and _NAME.match(org) and _NAME.match(project) and _ID.match(pipeline)
    ):
        return None
    encoded = base64.b64encode(f":{token}".encode()).decode()
    base = f"https://dev.azure.com/{quote(org)}/{quote(project)}/_apis/pipelines/{pipeline}/runs"
    return base, {"Authorization": f"Basic {encoded}", "User-Agent": "WorkPilot"}


def _azure_commit(
    fetch: Fetch, base: str, headers: dict, run_id: str
) -> tuple[str, str]:
    """(commit, refName) of one run."""
    status, doc = _json(fetch, f"{base}/{run_id}?api-version=7.1", headers)
    if status != 200 or not isinstance(doc, dict):
        return "", ""
    repo = ((doc.get("resources") or {}).get("repositories") or {}).get("self") or {}
    ref = repo.get("refName")
    return _sha(repo.get("version")), ref[:200] if isinstance(ref, str) else ""


def _azure_plan(env: dict, triggered: datetime, fetch: Fetch) -> RollbackPlan:
    context = _azure_context(env)
    if not context:
        return RollbackPlan("azure", "not_configured")
    base, headers = context
    status, doc = _json(fetch, f"{base}?api-version=7.1", headers)
    items = doc.get("value") if status == 200 and isinstance(doc, dict) else None
    if not isinstance(items, list):
        return RollbackPlan("azure", "unreachable")
    runs = []
    for item in items:
        at = _when(item.get("createdDate")) if isinstance(item, dict) else None
        if at and _ID.match(str(item.get("id"))):
            link = ((item.get("_links") or {}).get("web") or {}).get("href")
            runs.append(
                {
                    "at": at,
                    "good": item.get("result") == "succeeded",
                    "id": str(item["id"]),
                    "url": _https(link),
                }
            )
    good, current = _split(runs, triggered)
    if not good:
        return RollbackPlan("azure", "no_previous_success")
    sha, _ref = _azure_commit(fetch, base, headers, good["id"])
    if not sha:
        return RollbackPlan("azure", "unreachable", target_run=good["id"])
    current_sha = (
        _azure_commit(fetch, base, headers, current["id"])[0] if current else ""
    )
    return RollbackPlan(
        "azure",
        "redeploy_commit",
        automatic=True,
        target_run=good["id"],
        target_sha=sha,
        target_url=good["url"],
        target_at=good["at"].isoformat(),
        current_sha=current_sha,
    )


def _azure_execute(env: dict, plan: RollbackPlan, fetch: Fetch) -> bool:
    context = _azure_context(env)
    if not context or not _ID.match(plan.target_run) or not _sha(plan.target_sha):
        return False
    base, headers = context
    _sha_again, ref = _azure_commit(fetch, base, headers, plan.target_run)
    if not ref:
        return False
    body = {
        "resources": {
            "repositories": {"self": {"refName": ref, "version": plan.target_sha}}
        }
    }
    status, _ = _json(
        fetch, f"{base}?api-version=7.1", headers, method="POST", body=body
    )
    return status in (200, 201)


# ── GitLab CI and Jenkins: the last good one, by hand ─────────────────────────


def _gitlab_plan(env: dict, triggered: datetime, fetch: Fetch) -> RollbackPlan:
    token = str(env.get("CICD_GITLAB_TOKEN") or "")
    project = str(env.get("CICD_GITLAB_PROJECT_ID") or "")
    host = str(env.get("CICD_GITLAB_HOST") or "https://gitlab.com").rstrip("/")
    if not (token and project and valid_url(host) and host.startswith("https://")):
        return RollbackPlan("gitlab", "not_configured")
    url = f"{host}/api/v4/projects/{quote(project, safe='')}/pipelines?" + urlencode(
        {"per_page": 50}
    )
    status, items = _json(
        fetch, url, {"PRIVATE-TOKEN": token, "User-Agent": "WorkPilot"}
    )
    if status != 200 or not isinstance(items, list):
        return RollbackPlan("gitlab", "unreachable")
    runs = []
    for item in items:
        at = _when(item.get("created_at")) if isinstance(item, dict) else None
        if at and _ID.match(str(item.get("id"))):
            runs.append(
                {
                    "at": at,
                    "good": item.get("status") == "success",
                    "id": str(item["id"]),
                    "sha": _sha(item.get("sha")),
                    "url": _https(item.get("web_url")),
                }
            )
    good, current = _split(runs, triggered)
    if not good:
        return RollbackPlan("gitlab", "no_previous_success")
    return RollbackPlan(
        "gitlab",
        "manual",
        target_run=good["id"],
        target_sha=good["sha"],
        target_url=good["url"],
        target_at=good["at"].isoformat(),
        current_sha=current["sha"] if current else "",
    )


def _jenkins_sha(actions: object) -> str:
    """The commit the Git plugin says a build checked out, or ""."""
    for action in actions if isinstance(actions, list) else []:
        revision = action.get("lastBuiltRevision") if isinstance(action, dict) else None
        if isinstance(revision, dict) and _sha(revision.get("SHA1")):
            return revision["SHA1"]
    return ""


def _jenkins_plan(env: dict, triggered: datetime, fetch: Fetch) -> RollbackPlan:
    base = str(env.get("CICD_JENKINS_URL") or "").rstrip("/")
    job = str(env.get("CICD_JENKINS_JOB") or "")
    if not (valid_url(base) and _NAME.match(job)):
        return RollbackPlan("jenkins", "not_configured")
    headers = {"User-Agent": "WorkPilot"}
    token = str(env.get("CICD_JENKINS_TOKEN") or "")
    user = str(env.get("CICD_JENKINS_USER") or "")
    if token and base.startswith("https://"):
        headers["Authorization"] = (
            "Basic " + base64.b64encode(f"{user}:{token}".encode()).decode()
            if user
            else f"Bearer {token}"
        )
    url = f"{base}/job/{quote(job)}/api/json?" + urlencode(
        {
            "tree": "builds[number,result,timestamp,url,"
            "actions[lastBuiltRevision[SHA1]]]{0,50}"
        }
    )
    status, doc = _json(fetch, url, headers)
    items = doc.get("builds") if status == 200 and isinstance(doc, dict) else None
    if not isinstance(items, list):
        return RollbackPlan("jenkins", "unreachable")
    runs = []
    for item in items:
        stamp = item.get("timestamp") if isinstance(item, dict) else None
        if isinstance(stamp, int) and _ID.match(str(item.get("number"))):
            runs.append(
                {
                    "at": datetime.fromtimestamp(stamp / 1000, UTC),
                    "good": item.get("result") == "SUCCESS",
                    "id": str(item["number"]),
                    "sha": _jenkins_sha(item.get("actions")),
                    "url": item.get("url")
                    if valid_url(str(item.get("url") or ""))
                    else "",
                }
            )
    good, current = _split(runs, triggered)
    if not good:
        return RollbackPlan("jenkins", "no_previous_success")
    return RollbackPlan(
        "jenkins",
        "manual",
        target_run=good["id"],
        target_sha=good["sha"],
        target_url=good["url"],
        target_at=good["at"].isoformat(),
        current_sha=current["sha"] if current else "",
    )


# ── Dispatch ──────────────────────────────────────────────────────────────────


def plan_rollback(env: dict, run: dict, fetch: Fetch = default_fetch) -> RollbackPlan:
    """What a rollback of `run` (a record of `.workpilot/cicd_runs.json`) would do."""
    provider = str(run.get("provider") or env.get("CICD_PROVIDER") or "")
    triggered = _when(run.get("triggered_at"))
    if not triggered:
        return RollbackPlan(provider, "unsupported")
    try:
        if provider in ("github", "github_actions"):
            return _github_plan(env, run, triggered, fetch)
        if provider in ("azure", "azure_devops"):
            return _azure_plan(env, triggered, fetch)
        if provider == "gitlab":
            return _gitlab_plan(env, triggered, fetch)
        if provider == "jenkins":
            return _jenkins_plan(env, triggered, fetch)
    except OSError:
        return RollbackPlan(provider, "unreachable")
    return RollbackPlan(provider, "unsupported")


def execute_rollback(
    env: dict, run: dict, plan: RollbackPlan, fetch: Fetch = default_fetch
) -> bool:
    """Start the rollback a plan describes; False when it cannot or did not start."""
    if not plan.automatic:
        return False
    try:
        if plan.provider in ("github", "github_actions"):
            return _github_execute(env, run, plan, fetch)
        if plan.provider in ("azure", "azure_devops"):
            return _azure_execute(env, plan, fetch)
    except OSError:
        return False
    return False
