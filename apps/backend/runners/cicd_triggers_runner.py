#!/usr/bin/env python3
"""
CI/CD Deployment Triggers Runner (Feature 44)

Triggers deployment pipelines on GitHub Actions, GitLab CI, Azure DevOps,
and Jenkins after an agent creates a pull request.

Usage:
    python cicd_triggers_runner.py --action trigger --provider github --project /path --pr-url https://... [options]
    python cicd_triggers_runner.py --action status --run-id <id> --project /path
    python cicd_triggers_runner.py --action cancel --run-id <id> --project /path
"""

import argparse
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

#: One path segment of a provider API: a workflow file, a repository owner or name.
SEGMENT = re.compile(r"^(?!\.{1,2}$)[A-Za-z0-9._-]{1,255}$")
#: A pipeline run id, as the providers number them.
RUN_ID = re.compile(r"^[0-9]{1,20}$")
#: Headers that carry a credential.
CREDENTIAL_HEADERS = frozenset({"authorization", "private-token"})

SCHEME_REFUSAL = "CI/CD Triggers only calls http or https URLs."
PLAIN_HTTP_REFUSAL = (
    "CI/CD Triggers sends credentials over https only, or over http to a CI "
    "server on this machine. Use an https URL for this CI server."
)
STRICT_OFFLINE_REFUSAL = (
    "Strict offline mode is on for this project: CI/CD Triggers only reaches a "
    "CI server on this machine or the local network."
)
UNREADABLE_POLICY_REFUSAL = (
    "The project's offline policy (.workpilot/offline-mode.json) could not be "
    "read, so CI/CD Triggers reaches no remote CI server. Fix or remove that file."
)


def load_env(project_dir: str) -> dict:
    """The process environment, with the project's root `.env` underneath it.

    The desktop app passes the CI/CD settings (kept encrypted in
    `.workpilot/.env`) as environment variables; a stale value left in the
    root `.env` must not override them.
    """
    env = dict(os.environ)
    env_path = Path(project_dir) / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            key = line[:eq].strip()
            val = line[eq + 1 :].strip().strip("\"'")
            env.setdefault(key, val)
    return env


def _reach(url: str) -> str:
    """Where `url` points: "loopback", "private" (a local network literal) or "remote"."""
    host = urllib.parse.urlsplit(url).hostname or ""
    if host == "localhost":
        return "loopback"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "remote"
    if address.is_loopback:
        return "loopback"
    return "private" if address.is_private else "remote"


def outbound_refusal(url: str, headers: dict, project: str | None) -> str | None:
    """Why this request may not leave, or None.

    Only http(s); a credential over https, or over http to this machine; and
    under the project's strict offline mode, only a CI server on this machine
    or the local network. A policy that cannot be read counts as strict.
    """
    scheme = urllib.parse.urlsplit(url).scheme
    if scheme not in ("http", "https"):
        return SCHEME_REFUSAL
    reach = _reach(url)
    credential = any(name.lower() in CREDENTIAL_HEADERS for name in headers)
    if credential and reach != "loopback" and scheme != "https":
        return PLAIN_HTTP_REFUSAL
    if reach == "remote" and project is not None:
        from offline_policy import airgap_status

        try:
            strict = airgap_status(project)["airgapStrict"]
        except (OSError, ValueError):
            return UNREADABLE_POLICY_REFUSAL
        if strict:
            return STRICT_OFFLINE_REFUSAL
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as it came, never followed: urllib would copy the
    credential headers onto the request to the new address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())
# A CI server on this machine is called directly: a proxy from the environment
# would otherwise receive what may go over plain http only to this machine.
_DIRECT_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _NoRedirect()
)


def http_request(
    url: str,
    method: str = "GET",
    headers: dict | None = None,
    body: bytes | None = None,
    *,
    project: str | None = None,
) -> dict:
    """One request with the standard library, after `outbound_refusal`."""
    refusal = outbound_refusal(url, headers or {}, project)
    if refusal:
        return {"status": 0, "error": refusal}
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        opener = _DIRECT_OPENER if _reach(url) == "loopback" else _OPENER
        with opener.open(req, timeout=30) as resp:
            content = resp.read().decode("utf-8")
            try:
                return {"status": resp.status, "body": json.loads(content)}
            except Exception:
                return {"status": resp.status, "body": content}
    except urllib.error.HTTPError as e:
        content = e.read().decode("utf-8")
        return {"status": e.code, "error": content}
    except Exception as e:
        return {"status": 0, "error": str(e)}


# ── GitHub Actions ────────────────────────────────────────────────────────────


def _github_repo(pr_url: str) -> str:
    """owner/repo of a github.com pull request URL, or "" for anything else."""
    parts = urllib.parse.urlsplit(pr_url)
    segments = parts.path.strip("/").split("/")
    if parts.scheme != "https" or parts.hostname != "github.com" or len(segments) < 2:
        return ""
    owner, name = segments[0], segments[1]
    return f"{owner}/{name}" if SEGMENT.match(owner) and SEGMENT.match(name) else ""


def trigger_github(
    env: dict,
    branch: str,
    workflow: str | None = None,
    pr_url: str | None = None,
    *,
    project: str | None = None,
) -> dict:
    token = env.get("CICD_GITHUB_TOKEN", "")
    workflow_file = workflow or env.get("CICD_GITHUB_WORKFLOW", "")
    ref = env.get("CICD_GITHUB_REF", branch or "main")

    if not token:
        return {"error": "CICD_GITHUB_TOKEN not configured"}

    # Derive repo from pr_url or environment
    repo = env.get("CICD_GITHUB_REPO", "")
    if not repo and pr_url:
        repo = _github_repo(pr_url)

    if not repo:
        return {
            "error": "Could not determine GitHub repo (set CICD_GITHUB_REPO or pass --pr-url)"
        }

    if not workflow_file:
        return {"error": "CICD_GITHUB_WORKFLOW not configured (e.g. 'deploy.yml')"}
    if not SEGMENT.match(workflow_file):
        return {"error": "The GitHub workflow must be a file name such as 'deploy.yml'"}

    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow_file}/dispatches"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
    }
    body = json.dumps(
        {"ref": ref, "inputs": {"pr_url": pr_url or "", "branch": branch or ""}}
    ).encode()
    resp = http_request(url, method="POST", headers=headers, body=body, project=project)

    if resp["status"] in (204, 201, 200):
        return {
            "provider": "github",
            "status": "triggered",
            "workflow": workflow_file,
            "ref": ref,
            "repo": repo,
        }
    return {
        "provider": "github",
        "error": resp.get("error") or str(resp.get("body", "")),
        "status_code": resp["status"],
    }


# ── GitLab CI ─────────────────────────────────────────────────────────────────


def trigger_gitlab(
    env: dict, branch: str, pr_url: str | None = None, *, project: str | None = None
) -> dict:
    token = env.get("CICD_GITLAB_TOKEN", "")
    project_id = env.get("CICD_GITLAB_PROJECT_ID", "")
    ref = env.get("CICD_GITLAB_REF", branch or "main")
    gitlab_host = env.get("CICD_GITLAB_HOST", "https://gitlab.com")

    if not token:
        return {"error": "CICD_GITLAB_TOKEN not configured"}
    if not project_id:
        return {"error": "CICD_GITLAB_PROJECT_ID not configured"}

    url = f"{gitlab_host}/api/v4/projects/{project_id}/pipeline"
    headers = {"PRIVATE-TOKEN": token, "Content-Type": "application/json"}
    body = json.dumps({"ref": ref}).encode()
    resp = http_request(url, method="POST", headers=headers, body=body, project=project)

    if resp["status"] in (201, 200):
        pipeline = resp.get("body", {})
        return {
            "provider": "gitlab",
            "status": "triggered",
            "pipeline_id": pipeline.get("id") if isinstance(pipeline, dict) else None,
            "ref": ref,
            "web_url": pipeline.get("web_url") if isinstance(pipeline, dict) else None,
        }
    return {
        "provider": "gitlab",
        "error": resp.get("error") or str(resp.get("body", "")),
        "status_code": resp["status"],
    }


# ── Azure DevOps ──────────────────────────────────────────────────────────────


def trigger_azure(
    env: dict, branch: str, pr_url: str | None = None, *, project: str | None = None
) -> dict:
    token = env.get("CICD_AZURE_TOKEN", "")
    org = env.get("CICD_AZURE_ORG", "")
    azure_project = env.get("CICD_AZURE_PROJECT", "")
    pipeline_id = env.get("CICD_AZURE_PIPELINE_ID", "")
    ref = env.get("CICD_AZURE_REF", branch or "main")

    if not token or not org or not azure_project or not pipeline_id:
        return {
            "error": "Azure DevOps config incomplete (need CICD_AZURE_TOKEN, CICD_AZURE_ORG, CICD_AZURE_PROJECT, CICD_AZURE_PIPELINE_ID)"
        }

    import base64

    encoded = base64.b64encode(f":{token}".encode()).decode()
    url = f"https://dev.azure.com/{org}/{azure_project}/_apis/pipelines/{pipeline_id}/runs?api-version=7.0"
    headers = {
        "Authorization": f"Basic {encoded}",
        "Content-Type": "application/json",
    }
    body = json.dumps(
        {"resources": {"repositories": {"self": {"refName": f"refs/heads/{ref}"}}}}
    ).encode()
    resp = http_request(url, method="POST", headers=headers, body=body, project=project)

    if resp["status"] in (200, 201):
        run = resp.get("body", {})
        return {
            "provider": "azure",
            "status": "triggered",
            "run_id": run.get("id") if isinstance(run, dict) else None,
            "pipeline_id": pipeline_id,
            "web_url": run.get("_links", {}).get("web", {}).get("href")
            if isinstance(run, dict)
            else None,
        }
    return {
        "provider": "azure",
        "error": resp.get("error") or str(resp.get("body", "")),
        "status_code": resp["status"],
    }


# ── Jenkins ───────────────────────────────────────────────────────────────────


def trigger_jenkins(
    env: dict, branch: str, pr_url: str | None = None, *, project: str | None = None
) -> dict:
    jenkins_url = env.get("CICD_JENKINS_URL", "").rstrip("/")
    token = env.get("CICD_JENKINS_TOKEN", "")
    job = env.get("CICD_JENKINS_JOB", "")
    user = env.get("CICD_JENKINS_USER", "")

    if not jenkins_url or not job:
        return {
            "error": "Jenkins config incomplete (need CICD_JENKINS_URL, CICD_JENKINS_JOB)"
        }

    query = urllib.parse.urlencode({"BRANCH": branch or "main", "PR_URL": pr_url or ""})
    url = f"{jenkins_url}/job/{urllib.parse.quote(job)}/buildWithParameters?{query}"
    headers: dict = {}
    if user and token:
        import base64

        encoded = base64.b64encode(f"{user}:{token}".encode()).decode()
        headers["Authorization"] = f"Basic {encoded}"
    elif token:
        headers["Authorization"] = f"Bearer {token}"

    resp = http_request(url, method="POST", headers=headers, project=project)
    if resp["status"] in (200, 201, 302):
        return {
            "provider": "jenkins",
            "status": "triggered",
            "job": job,
            "branch": branch,
        }
    return {
        "provider": "jenkins",
        "error": resp.get("error") or str(resp.get("body", "")),
        "status_code": resp["status"],
    }


# ── Dispatch ──────────────────────────────────────────────────────────────────


def action_trigger(
    env: dict,
    provider: str,
    branch: str,
    workflow: str | None,
    pr_url: str | None,
    *,
    project: str | None = None,
) -> dict:
    p = provider.lower()
    if p in ("github", "github_actions"):
        return trigger_github(env, branch, workflow, pr_url, project=project)
    elif p in ("gitlab", "gitlab_ci"):
        return trigger_gitlab(env, branch, pr_url, project=project)
    elif p in ("azure", "azuredevops", "azure_devops"):
        return trigger_azure(env, branch, pr_url, project=project)
    elif p == "jenkins":
        return trigger_jenkins(env, branch, pr_url, project=project)
    else:
        return {
            "error": f"Unknown CI/CD provider: {provider}. Supported: github, gitlab, azure, jenkins"
        }


def _github_run(env: dict, run_id: str) -> tuple[str, str] | dict:
    """(token, repo) for a GitHub run, or the error that stops the call."""
    token = env.get("CICD_GITHUB_TOKEN", "")
    repo = env.get("CICD_GITHUB_REPO", "")
    if not repo or not token:
        return {"error": "Missing CICD_GITHUB_REPO or CICD_GITHUB_TOKEN"}
    if not RUN_ID.match(run_id):
        return {"error": "A run id is a number"}
    return token, repo


def action_status(
    env: dict, provider: str, run_id: str, *, project: str | None = None
) -> dict:
    """Get pipeline run status (provider-specific)."""
    p = provider.lower()

    if p in ("github", "github_actions"):
        checked = _github_run(env, run_id)
        if isinstance(checked, dict):
            return checked
        token, repo = checked
        url = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}"
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        }
        resp = http_request(url, headers=headers, project=project)
        if resp["status"] == 200:
            run = resp["body"]
            return {
                "run_id": run_id,
                "status": run.get("status"),
                "conclusion": run.get("conclusion"),
                "url": run.get("html_url"),
            }
        return {"error": resp.get("error") or str(resp.get("body", ""))}

    return {
        "status": "unknown",
        "note": f"Status polling not implemented for provider: {provider}",
    }


def action_cancel(
    env: dict, provider: str, run_id: str, *, project: str | None = None
) -> dict:
    """Cancel a running pipeline."""
    p = provider.lower()

    if p in ("github", "github_actions"):
        checked = _github_run(env, run_id)
        if isinstance(checked, dict):
            return checked
        token, repo = checked
        url = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/cancel"
        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        }
        resp = http_request(url, method="POST", headers=headers, project=project)
        return {"cancelled": resp["status"] == 202}

    return {
        "cancelled": False,
        "note": f"Cancel not implemented for provider: {provider}",
    }


def main():
    parser = argparse.ArgumentParser(description="CI/CD Triggers Runner")
    parser.add_argument(
        "--action", choices=["trigger", "status", "cancel"], required=True
    )
    parser.add_argument("--project", required=True)
    parser.add_argument("--provider", default="")
    parser.add_argument("--pr-url", default="")
    parser.add_argument("--branch", default="")
    parser.add_argument("--workflow", default=None)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--output-json", action="store_true")
    args = parser.parse_args()

    env = load_env(args.project)
    provider = args.provider or env.get("CICD_PROVIDER", "")

    try:
        if args.action == "trigger":
            result = action_trigger(
                env,
                provider,
                args.branch,
                args.workflow,
                args.pr_url,
                project=args.project,
            )
        elif args.action == "status":
            result = action_status(env, provider, args.run_id, project=args.project)
        else:
            result = action_cancel(env, provider, args.run_id, project=args.project)

        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if "error" not in result else 1)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    # Launched without PYTHONPATH: put the backend on the path for core.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
