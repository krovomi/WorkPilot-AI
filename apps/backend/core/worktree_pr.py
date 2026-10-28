"""Pushing a spec branch and opening its pull / merge request.

The PR half of `WorktreeManager`, split out of `core/worktree.py` (audit lot
L11, F36) as a mixin: `WorktreeManager` inherits it, so every method keeps its
name and its `self`. It relies on the manager for `_run_git`, the worktree
paths and the timeout constants.
"""

import asyncio
import json
import logging
import os
import re
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agents.impact_analyzer import ImpactAnalysis
from core.debug import debug_warning
from core.gh_executable import get_gh_executable, invalidate_gh_cache
from core.git_provider import (
    detect_git_provider,
    extract_azure_devops_org,
    extract_azure_devops_project,
    extract_azure_devops_repository,
)
from core.glab_executable import get_glab_executable, invalidate_glab_cache
from core.model_config import get_utility_model_config
from core.worktree_common import (
    PullRequestResult,
    PushAndCreatePRResult,
    PushBranchResult,
    _is_retryable_http_error,
    _is_retryable_network_error,
    _with_retry,
    _wt,
)
from foundation.git_executable import get_git_executable, get_isolated_git_env

# The name the monolith logged under (`core.worktree`), kept so logging
# configuration and log filters keyed on it still match.
logger = logging.getLogger(__name__.rpartition(".")[0] + ".worktree")


class WorktreePRMixin:
    """PR / MR creation for `WorktreeManager` (GitHub, GitLab, Azure DevOps)."""

    # ==================== PR Creation Methods ====================

    def push_branch(self, spec_name: str, force: bool = False) -> PushBranchResult:
        """
        Push a spec's branch to the remote origin with retry logic.

        Args:
            spec_name: The spec folder name
            force: Whether to force push (use with caution)

        Returns:
            PushBranchResult with keys:
                - success: bool
                - branch: str (branch name)
                - remote: str (if successful)
                - error: str (if failed)
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            return PushBranchResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        # Verify we have an actual branch name (not detached HEAD)
        # get_worktree_info already falls back to expected branch name for detached HEAD,
        # but we also need to re-attach HEAD to the branch in the worktree so git push works.
        head_check = self._run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=info.path)
        if head_check.returncode == 0 and head_check.stdout.strip() == "HEAD":
            # Resolve the target branch: first check git's worktree registry (which
            # tracks the original branch even when detached), then fall back to the
            # expected branch name derived from the spec name.
            target_branch = self._get_worktree_registered_branch(info.path)
            if not target_branch:
                target_branch = self.get_branch_name(spec_name)
            debug_warning(
                "worktree",
                f"Re-attaching detached HEAD to branch '{target_branch}' before push",
            )
            # Check if the target branch exists locally
            if self._branch_exists(target_branch):
                # Move the branch ref to current commit and switch to it
                current_commit = self._run_git(["rev-parse", "HEAD"], cwd=info.path)
                if current_commit.returncode != 0:
                    return PushBranchResult(
                        success=False,
                        branch=target_branch,
                        error=f"Failed to resolve HEAD commit: {current_commit.stderr}",
                    )
                commit_sha = current_commit.stdout.strip()
                # Update the branch to point to current commit
                branch_update = self._run_git(
                    ["branch", "-f", target_branch, commit_sha],
                    cwd=info.path,
                )
                if branch_update.returncode != 0:
                    return PushBranchResult(
                        success=False,
                        branch=target_branch,
                        error=f"Failed to update branch '{target_branch}' to commit {commit_sha}: {branch_update.stderr}",
                    )
                # Switch to the branch
                switch_result = self._run_git(
                    ["checkout", target_branch], cwd=info.path
                )
                if switch_result.returncode != 0:
                    return PushBranchResult(
                        success=False,
                        branch=target_branch,
                        error=f"Failed to re-attach to branch '{target_branch}': {switch_result.stderr}",
                    )
            else:
                # Branch doesn't exist locally - create it at current HEAD
                checkout_result = self._run_git(
                    ["checkout", "-b", target_branch], cwd=info.path
                )
                if checkout_result.returncode != 0:
                    return PushBranchResult(
                        success=False,
                        branch=target_branch,
                        error=f"Failed to create branch '{target_branch}': {checkout_result.stderr}",
                    )

        # Push the branch to origin
        push_args = ["push", "-u", "origin", info.branch]
        if force:
            push_args.insert(1, "--force")

        # Authenticate the push with the Azure DevOps PAT when applicable, so it
        # doesn't fall back to the (often missing/read-only) credential manager
        # and 403. No-op for GitHub/GitLab.
        push_env = self._inject_azure_push_auth(get_isolated_git_env())

        def do_push() -> tuple[bool, PushBranchResult | None, str]:
            """Execute push operation for retry wrapper."""
            try:
                git_executable = get_git_executable()
                result = subprocess.run(
                    [git_executable] + push_args,
                    cwd=info.path,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.GIT_PUSH_TIMEOUT,
                    env=push_env,
                )

                if result.returncode == 0:
                    return (
                        True,
                        PushBranchResult(
                            success=True,
                            branch=info.branch,
                            remote="origin",
                        ),
                        "",
                    )
                return (False, None, result.stderr)
            except FileNotFoundError:
                return (False, None, "git executable not found")

        max_retries = 3
        result, last_error = _with_retry(
            operation=do_push,
            max_retries=max_retries,
            is_retryable=_is_retryable_network_error,
        )

        if result:
            return result

        # Handle timeout error message
        if last_error == "Operation timed out":
            return PushBranchResult(
                success=False,
                branch=info.branch,
                error=f"Push timed out after {max_retries} attempts.",
            )

        error_msg = f"Failed to push branch: {last_error}"
        # A 403 after we've injected the PAT means the token itself is rejected —
        # almost always an insufficient scope. Point the user straight at it.
        if last_error and "403" in last_error:
            error_msg += (
                " — HTTP 403 (accès refusé). Vérifiez que le PAT Azure DevOps a "
                "le scope « Code (Read & Write) » et qu'il n'est pas expiré."
            )
        return PushBranchResult(
            success=False,
            branch=info.branch,
            error=error_msg,
        )

    def _get_azure_devops_credentials(self) -> tuple[str, str] | None:
        """Get Azure DevOps credentials from git credential manager or environment.

        Tries in order:
        1. AZURE_DEVOPS_PAT environment variable
        2. Git credential manager (same credentials used for git push)

        Returns:
            Tuple of (username, password/PAT) or None if no credentials found.
        """
        # 1. Check for PAT in environment
        pat = os.environ.get("AZURE_DEVOPS_PAT") or os.environ.get(
            "AZURE_DEVOPS_EXT_PAT"
        )
        if pat:
            return ("", pat)

        # 2. Try git credential manager
        try:
            remote_result = self._run_git(
                ["remote", "get-url", "origin"], cwd=self.project_dir
            )
            if remote_result.returncode != 0 or not remote_result.stdout.strip():
                return None

            remote_url = remote_result.stdout.strip()

            # Parse the remote URL to extract protocol, host, and path
            from urllib.parse import urlparse

            parsed = urlparse(remote_url)
            if not parsed.hostname:
                return None

            # Build credential fill input
            cred_input = f"protocol={parsed.scheme}\nhost={parsed.hostname}\npath={parsed.path.lstrip('/')}\n\n"

            git_executable = get_git_executable()
            result = subprocess.run(
                [git_executable, "credential", "fill"],
                input=cred_input,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                cwd=self.project_dir,
                env=get_isolated_git_env(),
            )

            if result.returncode == 0 and result.stdout:
                username = ""
                password = ""
                for line in result.stdout.strip().split("\n"):
                    if line.startswith("username="):
                        username = line[len("username=") :]
                    elif line.startswith("password="):
                        password = line[len("password=") :]
                if password:
                    return (username, password)

        except Exception as e:
            logger.debug(f"Failed to get credentials from git credential manager: {e}")

        return None

    def _inject_azure_push_auth(self, base_env: dict) -> dict:
        """Return ``base_env`` augmented so ``git push`` authenticates to Azure
        DevOps with the configured PAT.

        Azure DevOps HTTPS push relies on git's ambient credential manager, which
        on many setups is missing or holds a read-only credential — the push then
        fails with **HTTP 403** even though the PAT used for the REST API is
        valid. Here we inject ``http.extraheader: Authorization: Basic <b64>``
        (empty user + PAT as password, the Azure-documented scheme) so the push
        uses the same PAT as everything else.

        The header is passed via ``GIT_CONFIG_*`` env vars (git 2.31+), not the
        command line, so the PAT never appears in argv or in captured stderr.
        No-op unless the remote is Azure DevOps and a PAT is resolvable.
        """
        try:
            provider = detect_git_provider(self.project_dir)
        except Exception:
            provider = None
        if provider != "azure_devops":
            return base_env

        creds = self._get_azure_devops_credentials()
        if not creds:
            return base_env
        _username, pat = creds
        if not pat:
            return base_env

        import base64

        token = base64.b64encode(f":{pat}".encode()).decode("ascii")
        env = dict(base_env)
        try:
            index = int(env.get("GIT_CONFIG_COUNT", "0"))
        except ValueError:
            index = 0
        env[f"GIT_CONFIG_KEY_{index}"] = "http.extraheader"
        env[f"GIT_CONFIG_VALUE_{index}"] = f"Authorization: Basic {token}"
        env["GIT_CONFIG_COUNT"] = str(index + 1)
        return env

    def create_azure_pull_request(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
        body: str | None = None,
    ) -> PullRequestResult:
        """
        Create an Azure DevOps pull request using the REST API.

        Uses git credential manager or AZURE_DEVOPS_PAT environment variable
        for authentication (same credentials that git push uses).

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for PR (defaults to base_branch)
            title: PR title (defaults to spec name)
            draft: Whether to create as draft PR
            body: PR body. If provided, used as-is (no AI generation, no
                  impact block injection); otherwise body is auto-generated.

        Returns:
            PullRequestResult with keys:
                - success: bool
                - pr_url: str (if created)
                - already_exists: bool (if PR already exists)
                - error: str (if failed)
        """
        import requests

        info = self.get_worktree_info(spec_name)
        if not info:
            return PullRequestResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        target = target_branch or self.base_branch
        pr_title = title or f"feat: {spec_name}"

        # Caller-provided body wins. Otherwise try AI-powered PR body from
        # project's PR template, falling back to spec summary, then append
        # the impact block.
        pr_body: str | None = body
        caller_provided_body = body is not None
        diff_summary: str = ""
        commit_log: str = ""
        if pr_body is None:
            try:
                diff_summary, commit_log = self._gather_pr_context(spec_name, target)
                pr_body = self._try_ai_pr_body(
                    spec_name=spec_name,
                    target_branch=target,
                    branch_name=info.branch,
                    diff_summary=diff_summary,
                    commit_log=commit_log,
                )
            except Exception as e:
                logger.warning(f"AI PR body generation encountered an error: {e}")

            if not pr_body:
                pr_body = self._extract_spec_summary(spec_name)

        if not caller_provided_body:
            pr_body = self._inject_impact_block(
                spec_name=spec_name,
                body=pr_body,
                diff_summary=diff_summary,
                commit_log=commit_log,
            )

        # Extract Azure DevOps coordinates from git remote
        org = extract_azure_devops_org(self.project_dir)
        project = extract_azure_devops_project(self.project_dir)
        repository = extract_azure_devops_repository(self.project_dir)

        if not org:
            return PullRequestResult(
                success=False,
                error="Could not extract Azure DevOps organization from git remote URL",
            )
        if not project:
            return PullRequestResult(
                success=False,
                error="Could not extract Azure DevOps project from git remote URL",
            )
        if not repository:
            return PullRequestResult(
                success=False,
                error="Could not extract Azure DevOps repository from git remote URL",
            )

        # Get credentials
        credentials = self._get_azure_devops_credentials()
        if not credentials:
            return PullRequestResult(
                success=False,
                error=(
                    "No Azure DevOps credentials found. "
                    "Set AZURE_DEVOPS_PAT environment variable or configure git credential manager."
                ),
            )

        username, password = credentials
        auth = (username, password)

        # URL-encode project and repository for API calls
        from urllib.parse import quote

        project_encoded = quote(project, safe="")
        repository_encoded = quote(repository, safe="")
        base_url = f"https://dev.azure.com/{quote(org, safe='')}/{project_encoded}/_apis/git/repositories/{repository_encoded}"
        api_version = "api-version=7.1"

        def is_pr_retryable(stderr: str) -> bool:
            """Check if PR creation error is retryable (network or HTTP 5xx)."""
            return _is_retryable_network_error(stderr) or _is_retryable_http_error(
                stderr
            )

        def do_create_pr() -> tuple[bool, PullRequestResult | None, str]:
            """Execute PR creation for retry wrapper."""
            try:
                # Check if PR already exists
                try:
                    search_url = (
                        f"{base_url}/pullrequests?{api_version}"
                        f"&searchCriteria.sourceRefName=refs/heads/{info.branch}"
                        f"&searchCriteria.targetRefName=refs/heads/{target}"
                        f"&searchCriteria.status=active"
                    )
                    resp = requests.get(search_url, auth=auth, timeout=30)
                    if resp.status_code == 200:
                        data = resp.json()
                        prs = data.get("value", [])
                        if prs:
                            # PR already exists — build the web URL
                            pr_id = prs[0].get("pullRequestId")
                            pr_url = (
                                f"https://dev.azure.com/{quote(org, safe='')}"
                                f"/{project_encoded}/_git/{repository_encoded}"
                                f"/pullrequest/{pr_id}"
                            )
                            return (
                                True,
                                PullRequestResult(
                                    success=True,
                                    pr_url=pr_url,
                                    already_exists=True,
                                ),
                                "",
                            )
                except Exception:
                    # Continue with creation if check fails
                    pass

                # Create pull request via REST API
                create_url = f"{base_url}/pullrequests?{api_version}"
                payload: dict = {
                    "sourceRefName": f"refs/heads/{info.branch}",
                    "targetRefName": f"refs/heads/{target}",
                    "title": pr_title,
                    "description": pr_body or "",
                }
                if draft:
                    payload["isDraft"] = True

                resp = requests.post(
                    create_url,
                    json=payload,
                    auth=auth,
                    timeout=30,
                )

                if resp.status_code in (200, 201):
                    data = resp.json()
                    pr_id = data.get("pullRequestId")
                    pr_url = (
                        f"https://dev.azure.com/{quote(org, safe='')}"
                        f"/{project_encoded}/_git/{repository_encoded}"
                        f"/pullrequest/{pr_id}"
                    )
                    return (
                        True,
                        PullRequestResult(
                            success=True,
                            pr_url=pr_url,
                            already_exists=False,
                        ),
                        "",
                    )

                # Handle specific error cases
                error_body = resp.text
                if resp.status_code == 409 or "already exists" in error_body.lower():
                    # PR already exists — try to find it
                    try:
                        search_url = (
                            f"{base_url}/pullrequests?{api_version}"
                            f"&searchCriteria.sourceRefName=refs/heads/{info.branch}"
                            f"&searchCriteria.targetRefName=refs/heads/{target}"
                            f"&searchCriteria.status=active"
                        )
                        search_resp = requests.get(search_url, auth=auth, timeout=30)
                        if search_resp.status_code == 200:
                            prs = search_resp.json().get("value", [])
                            if prs:
                                pr_id = prs[0].get("pullRequestId")
                                pr_url = (
                                    f"https://dev.azure.com/{quote(org, safe='')}"
                                    f"/{project_encoded}/_git/{repository_encoded}"
                                    f"/pullrequest/{pr_id}"
                                )
                                return (
                                    True,
                                    PullRequestResult(
                                        success=True,
                                        pr_url=pr_url,
                                        already_exists=True,
                                    ),
                                    "",
                                )
                    except Exception:
                        pass

                if resp.status_code == 401:
                    return (
                        False,
                        None,
                        "Azure DevOps authentication failed. Check your PAT or credentials.",
                    )
                if resp.status_code == 403:
                    return (
                        False,
                        None,
                        "Azure DevOps access denied. Ensure your PAT has 'Code (Read & Write)' scope.",
                    )

                # Try to parse error message from response
                try:
                    err_data = resp.json()
                    err_msg = err_data.get("message", error_body)
                except Exception:
                    err_msg = error_body

                return (
                    False,
                    None,
                    f"Azure DevOps API error (HTTP {resp.status_code}): {err_msg}",
                )

            except requests.exceptions.Timeout:
                return (False, None, "timeout")
            except requests.exceptions.ConnectionError as e:
                return (False, None, f"connection error: {e}")
            except Exception as e:
                return (
                    False,
                    None,
                    f"Failed to create Azure DevOps pull request: {e}",
                )

        # Execute with retry logic
        result, last_error = _with_retry(
            operation=do_create_pr,
            max_retries=3,
            is_retryable=is_pr_retryable,
        )

        if result is None:
            return PullRequestResult(
                success=False,
                error=last_error or "Unknown error creating Azure DevOps pull request",
            )

        return result

    def create_pull_request(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
        body: str | None = None,
    ) -> PullRequestResult:
        """
        Create a GitHub pull request for a spec's branch using gh CLI with retry logic.

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for PR (defaults to base_branch)
            title: PR title (defaults to spec name)
            draft: Whether to create as draft PR
            body: PR body. If provided, used as-is; otherwise the body is
                  auto-generated (AI-powered from project template, falling
                  back to spec summary).

        Returns:
            PullRequestResult with keys:
                - success: bool
                - pr_url: str (if created)
                - already_exists: bool (if PR already exists)
                - error: str (if failed)
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            return PullRequestResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        target = target_branch or self.base_branch
        pr_title = title or f"feat: {spec_name}"

        # Caller-provided body wins. Otherwise try AI-powered PR body from
        # project's PR template, falling back to spec summary.
        pr_body: str | None = body
        caller_provided_body = body is not None
        diff_summary: str = ""
        commit_log: str = ""
        if pr_body is None:
            try:
                diff_summary, commit_log = self._gather_pr_context(spec_name, target)
                pr_body = self._try_ai_pr_body(
                    spec_name=spec_name,
                    target_branch=target,
                    branch_name=info.branch,
                    diff_summary=diff_summary,
                    commit_log=commit_log,
                )
            except Exception as e:
                logger.warning(f"AI PR body generation encountered an error: {e}")

            if not pr_body:
                pr_body = self._extract_spec_summary(spec_name)

        # Append impact block only when we composed the body ourselves; if the
        # caller provided a body they are responsible for it (they likely
        # included or edited the impact block via the review modal).
        if not caller_provided_body:
            pr_body = self._inject_impact_block(
                spec_name=spec_name,
                body=pr_body,
                diff_summary=diff_summary,
                commit_log=commit_log,
            )

        # Find gh executable before attempting PR creation
        gh_executable = get_gh_executable()
        if not gh_executable:
            return PullRequestResult(
                success=False,
                error="GitHub CLI (gh) not found. Install from https://cli.github.com/",
            )

        # Build gh pr create command
        gh_args = [
            gh_executable,
            "pr",
            "create",
            "--base",
            target,
            "--head",
            info.branch,
            "--title",
            pr_title,
            "--body",
            pr_body,
        ]
        if draft:
            gh_args.append("--draft")

        def is_pr_retryable(stderr: str) -> bool:
            """Check if PR creation error is retryable (network or HTTP 5xx)."""
            return _is_retryable_network_error(stderr) or _is_retryable_http_error(
                stderr
            )

        def do_create_pr() -> tuple[bool, PullRequestResult | None, str]:
            """Execute PR creation for retry wrapper."""
            try:
                result = subprocess.run(
                    gh_args,
                    cwd=info.path,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.CLI_TIMEOUT,
                    env=get_isolated_git_env(),
                )

                # Check for "already exists" case (success, no retry needed)
                if result.returncode != 0 and "already exists" in result.stderr.lower():
                    existing_url = self._get_existing_pr_url(spec_name, target)
                    result_dict = PullRequestResult(
                        success=True,
                        pr_url=existing_url,
                        already_exists=True,
                    )
                    if existing_url is None:
                        result_dict["message"] = (
                            "PR already exists but URL could not be retrieved"
                        )
                    return (True, result_dict, "")

                if result.returncode == 0:
                    # Extract PR URL from output
                    pr_url: str | None = result.stdout.strip()
                    if not pr_url.startswith("http"):
                        # Try to find URL in output
                        # Use general pattern to support GitHub Enterprise instances
                        # Matches any HTTPS URL with /pull/<number> path
                        match = re.search(r"https://[^\s]+/pull/\d+", result.stdout)
                        if match:
                            pr_url = match.group(0)
                        else:
                            # Invalid output - no valid URL found
                            pr_url = None

                    return (
                        True,
                        PullRequestResult(
                            success=True,
                            pr_url=pr_url,
                            already_exists=False,
                        ),
                        "",
                    )

                return (False, None, result.stderr)

            except FileNotFoundError:
                # gh CLI not installed - not retryable, raise to exit retry loop
                raise

        max_retries = 3
        try:
            result, last_error = _with_retry(
                operation=do_create_pr,
                max_retries=max_retries,
                is_retryable=is_pr_retryable,
            )

            if result:
                return result

            # Handle timeout error message
            if last_error == "Operation timed out":
                return PullRequestResult(
                    success=False,
                    error=f"PR creation timed out after {max_retries} attempts.",
                )

            return PullRequestResult(
                success=False,
                error=f"Failed to create PR: {last_error}",
            )

        except FileNotFoundError:
            # Cached gh path became invalid - clear cache so next call re-discovers
            invalidate_gh_cache()
            return PullRequestResult(
                success=False,
                error="GitHub CLI (gh) not found. Install from https://cli.github.com/",
            )

    def create_merge_request(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
        body: str | None = None,
    ) -> PullRequestResult:
        """
        Create a GitLab merge request for a spec's branch using glab CLI with retry logic.

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for MR (defaults to base_branch)
            title: MR title (defaults to spec name)
            draft: Whether to create as draft MR
            body: MR body. If provided, used as-is (no auto-generation, no
                  impact block injection); otherwise body is auto-generated.

        Returns:
            PullRequestResult with keys:
                - success: bool
                - pr_url: str (if created)
                - already_exists: bool (if MR already exists)
                - error: str (if failed)
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            return PullRequestResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        target = target_branch or self.base_branch
        mr_title = title or f"feat: {spec_name}"

        # Caller-provided body wins. Otherwise spec summary + impact block.
        if body is not None:
            mr_body = body
        else:
            mr_body = self._extract_spec_summary(spec_name)
            try:
                diff_summary, commit_log = self._gather_pr_context(spec_name, target)
            except Exception as e:
                logger.warning(f"Could not gather PR context for impact block: {e}")
                diff_summary, commit_log = "", ""
            mr_body = self._inject_impact_block(
                spec_name=spec_name,
                body=mr_body,
                diff_summary=diff_summary,
                commit_log=commit_log,
            )

        # Find glab executable before attempting MR creation
        glab_executable = get_glab_executable()
        if not glab_executable:
            return PullRequestResult(
                success=False,
                error="GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli",
            )

        # Build glab mr create command
        glab_args = [
            glab_executable,
            "mr",
            "create",
            "--target-branch",
            target,
            "--source-branch",
            info.branch,
            "--title",
            mr_title,
            "--description",
            mr_body,
        ]
        if draft:
            glab_args.append("--draft")

        def is_mr_retryable(stderr: str) -> bool:
            """Check if MR creation error is retryable (network or HTTP 5xx)."""
            return _is_retryable_network_error(stderr) or _is_retryable_http_error(
                stderr
            )

        def do_create_mr() -> tuple[bool, PullRequestResult | None, str]:
            """Execute MR creation for retry wrapper."""
            try:
                result = subprocess.run(
                    glab_args,
                    cwd=info.path,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.CLI_TIMEOUT,
                    env=get_isolated_git_env(),
                )

                # Check for "already exists" case (success, no retry needed)
                if result.returncode != 0 and "already exists" in result.stderr.lower():
                    existing_url = self._get_existing_mr_url(spec_name, target)
                    result_dict = PullRequestResult(
                        success=True,
                        pr_url=existing_url,
                        already_exists=True,
                    )
                    if existing_url is None:
                        result_dict["message"] = (
                            "MR already exists but URL could not be retrieved"
                        )
                    return (True, result_dict, "")

                if result.returncode == 0:
                    # Extract MR URL from output
                    mr_url: str | None = result.stdout.strip()
                    if not mr_url.startswith("http"):
                        # Try to find URL in output
                        # GitLab URL pattern: matches any HTTPS URL with /merge_requests/<number> or /-/merge_requests/<number> path
                        match = re.search(
                            r"https://[^\s]+(?:/merge_requests/|/-/merge_requests/)\d+",
                            result.stdout,
                        )
                        if match:
                            mr_url = match.group(0)
                        else:
                            # Invalid output - no valid URL found
                            mr_url = None

                    return (
                        True,
                        PullRequestResult(
                            success=True,
                            pr_url=mr_url,
                            already_exists=False,
                        ),
                        "",
                    )

                return (False, None, result.stderr)

            except FileNotFoundError:
                # glab CLI not installed - not retryable, raise to exit retry loop
                raise

        max_retries = 3
        try:
            result, last_error = _with_retry(
                operation=do_create_mr,
                max_retries=max_retries,
                is_retryable=is_mr_retryable,
            )

            if result:
                return result

            # Handle timeout error message
            if last_error == "Operation timed out":
                return PullRequestResult(
                    success=False,
                    error=f"MR creation timed out after {max_retries} attempts.",
                )

            return PullRequestResult(
                success=False,
                error=f"Failed to create MR: {last_error}",
            )

        except FileNotFoundError:
            # Cached glab path became invalid - clear cache so next call re-discovers
            invalidate_glab_cache()
            return PullRequestResult(
                success=False,
                error="GitLab CLI (glab) not found. Install from https://gitlab.com/gitlab-org/cli",
            )

    def _gather_pr_context(self, spec_name: str, target_branch: str) -> tuple[str, str]:
        """
        Gather diff summary and commit log for PR template filling.

        Args:
            spec_name: The spec folder name
            target_branch: The target branch for the PR

        Returns:
            Tuple of (diff_summary, commit_log)
        """
        worktree_path = self.get_worktree_path(spec_name)
        info = self.get_worktree_info(spec_name)
        branch = info.branch if info else self.get_branch_name(spec_name)

        # Get diff summary (stat for overview)
        diff_result = self._run_git(
            ["diff", "--stat", f"{target_branch}...{branch}"],
            cwd=worktree_path,
            timeout=30,
        )
        diff_summary = diff_result.stdout.strip() if diff_result.returncode == 0 else ""

        # Get shortstat for quick summary
        shortstat_result = self._run_git(
            ["diff", "--shortstat", f"{target_branch}...{branch}"],
            cwd=worktree_path,
            timeout=30,
        )
        if shortstat_result.returncode == 0 and shortstat_result.stdout.strip():
            diff_summary += "\n\n" + shortstat_result.stdout.strip()

        # Get actual code changes (patch format) for better AI context
        # Truncate to 30k chars to avoid token limits while still providing meaningful context
        patch_result = self._run_git(
            ["diff", "-p", "--stat-width=999", f"{target_branch}...{branch}"],
            cwd=worktree_path,
            timeout=30,
        )
        if patch_result.returncode == 0 and patch_result.stdout.strip():
            patch_content = patch_result.stdout.strip()
            MAX_DIFF_CHARS = 30_000

            if len(patch_content) > MAX_DIFF_CHARS:
                # Truncate patch and add notice
                truncated_patch = patch_content[:MAX_DIFF_CHARS]
                diff_summary += (
                    "\n\n" + truncated_patch + "\n\n(... diff truncated due to size)"
                )
            else:
                diff_summary += "\n\n" + patch_content

        # Get commit log
        log_result = self._run_git(
            [
                "log",
                "--oneline",
                "--no-merges",
                f"{target_branch}..{branch}",
            ],
            cwd=worktree_path,
            timeout=30,
        )
        commit_log = log_result.stdout.strip() if log_result.returncode == 0 else ""

        return diff_summary, commit_log

    def _try_ai_pr_body(
        self,
        spec_name: str,
        target_branch: str,
        branch_name: str,
        diff_summary: str,
        commit_log: str,
    ) -> str | None:
        """
        Attempt to generate a PR body using the AI template filler agent.

        Runs the async agent synchronously with a 30-second timeout.
        Returns None on any failure so the caller can fall back gracefully.

        Args:
            spec_name: The spec folder name
            target_branch: The target branch for the PR
            branch_name: The source branch name
            diff_summary: Git diff summary of changes
            commit_log: Git log of commits

        Returns:
            The AI-generated PR body string, or None if unavailable.
        """
        try:
            from agents.pr_template_filler import (
                detect_pr_template,
                run_pr_template_filler,
            )
        except ImportError:
            logger.warning(
                "PR template filler module not available, skipping AI PR body"
            )
            return None

        # Check if a PR template exists before doing any heavy lifting
        template = detect_pr_template(self.project_dir)
        if template is None:
            return None

        # Resolve spec directory
        spec_dir = self.project_dir / ".workpilot" / "specs" / spec_name
        if not spec_dir.is_dir():
            # Try worktree-local spec path
            worktree_path = self.get_worktree_path(spec_name)
            spec_dir = worktree_path / ".workpilot" / "specs" / spec_name
            if not spec_dir.is_dir():
                logger.warning("Spec directory not found for AI PR body generation")
                return None

        # Get model configuration from environment (respects user settings)
        model, thinking_budget = get_utility_model_config()

        async def _run_with_timeout() -> str | None:
            try:
                return await asyncio.wait_for(
                    run_pr_template_filler(
                        project_dir=self.project_dir,
                        spec_dir=spec_dir,
                        model=model,
                        thinking_budget=thinking_budget,
                        branch_name=branch_name,
                        target_branch=target_branch,
                        diff_summary=diff_summary,
                        commit_log=commit_log,
                        verbose=False,
                    ),
                    timeout=30.0,
                )
            except TimeoutError:
                logger.warning("PR template filler timed out after 30s")
                return None

        try:
            # Check if there's already a running event loop
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                # We're already inside an async context — run in a new thread
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(asyncio.run, _run_with_timeout())
                    return future.result(timeout=35)
            else:
                return asyncio.run(_run_with_timeout())

        except Exception as e:
            logger.warning(f"AI PR body generation failed: {e}")
            return None

    def _run_impact_analysis(
        self,
        spec_name: str,
        diff_summary: str,
        commit_log: str,
    ) -> "ImpactAnalysis":
        """
        Run the impact analyzer and return its result, falling back to
        the "N/A / Non evalue" analysis on any failure. Never raises.

        Returns:
            An ImpactAnalysis (always non-None thanks to the fallback).
        """
        from agents.impact_analyzer import (
            fallback_analysis,
            run_impact_analyzer_sync,
        )

        spec_dir = self.project_dir / ".workpilot" / "specs" / spec_name
        if not spec_dir.is_dir():
            worktree_path = self.get_worktree_path(spec_name)
            spec_dir = worktree_path / ".workpilot" / "specs" / spec_name
            if not spec_dir.is_dir():
                spec_dir = self.project_dir  # last resort, analyzer tolerates this

        model, thinking_budget = get_utility_model_config()

        analysis = run_impact_analyzer_sync(
            project_dir=self.project_dir,
            spec_dir=spec_dir,
            model=model,
            thinking_budget=thinking_budget,
            diff_summary=diff_summary,
            commit_log=commit_log,
        )
        return analysis if analysis is not None else fallback_analysis()

    def _inject_impact_block(
        self,
        spec_name: str,
        body: str,
        diff_summary: str,
        commit_log: str,
    ) -> str:
        """
        Append a French-language impact block to a PR/MR body.

        Runs the impact_analyzer agent on the diff and appends a standardized
        block at the end of the body:

            ---
            <!-- workpilot-impact-block -->
            Note de l'impact (1 a 5) : 3
            Fonctionnalite(s) impactee(s) : Fiche vehicule, doc de vente

        On any failure, falls back to "N/A" / "Non evalue" so the block is
        always present (per user spec). Never raises.
        """
        try:
            from agents.impact_analyzer import append_impact_block
        except ImportError:
            logger.warning(
                "impact_analyzer module not available, skipping impact block"
            )
            return body

        analysis = self._run_impact_analysis(spec_name, diff_summary, commit_log)
        return append_impact_block(body, analysis)

    def preview_pr_body(
        self,
        spec_name: str,
        target_branch: str | None = None,
        include_impact: bool = True,
    ) -> dict:
        """
        Compute what the PR body and impact analysis would be, WITHOUT
        actually pushing or creating any PR. Intended for the frontend
        review modal so the user can edit values before creation.

        Returns a dict with:
            - body: str  (PR body markdown, with impact block appended if include_impact)
            - rating: str  ("1".."5" or "N/A")
            - features: str  (French free-text summary, possibly "Non evalue")
            - error: str  (set only on hard failure; other fields still present)
        """
        try:
            from agents.impact_analyzer import append_impact_block
        except ImportError:
            append_impact_block = None  # type: ignore[assignment]

        target = target_branch or self.base_branch
        info = self.get_worktree_info(spec_name)
        branch_name = info.branch if info else ""

        try:
            diff_summary, commit_log = self._gather_pr_context(spec_name, target)
        except Exception as e:
            logger.warning(f"preview_pr_body: could not gather context: {e}")
            diff_summary, commit_log = "", ""

        body: str | None = None
        try:
            body = self._try_ai_pr_body(
                spec_name=spec_name,
                target_branch=target,
                branch_name=branch_name,
                diff_summary=diff_summary,
                commit_log=commit_log,
            )
        except Exception as e:
            logger.warning(f"preview_pr_body: AI body failed: {e}")
        if not body:
            body = self._extract_spec_summary(spec_name)

        analysis = self._run_impact_analysis(spec_name, diff_summary, commit_log)

        body_with_block = body
        if include_impact and append_impact_block is not None:
            body_with_block = append_impact_block(body, analysis)

        return {
            "body": body_with_block,
            "rating": analysis.rating,
            "features": analysis.features,
        }

    def _extract_spec_summary(self, spec_name: str) -> str:
        """
        Build a rich Markdown PR/MR body from the spec summary.

        Extracts the first paragraphs of ``spec.md`` and wraps them in a
        localised template that includes a review checklist and footer.
        When no spec is available the method returns a minimal fallback body.

        Args:
            spec_name: The spec folder name (e.g. ``001-my-feature``).

        Returns:
            Formatted Markdown string ready to be used as a PR/MR body.
        """
        # ── locate spec.md ────────────────────────────────────────────
        worktree_path = self.get_worktree_path(spec_name)
        spec_path = worktree_path / ".workpilot" / "specs" / spec_name / "spec.md"

        if not spec_path.exists():
            # Try project spec path
            spec_path = (
                self.project_dir / ".workpilot" / "specs" / spec_name / "spec.md"
            )

        # ── extract raw summary text ──────────────────────────────────
        raw_summary: str | None = None
        if spec_path.exists():
            try:
                content = spec_path.read_text(encoding="utf-8")
                lines = content.split("\n")
                summary_lines: list[str] = []
                in_content = False

                for line in lines:
                    if line.startswith("# "):
                        continue
                    if line.strip() and not line.startswith("#"):
                        in_content = True
                    if in_content:
                        if line.startswith("## ") and summary_lines:
                            break
                        summary_lines.append(line)
                        if len(summary_lines) >= 10:
                            break

                text = "\n".join(summary_lines).strip()
                if text:
                    raw_summary = text
            except (OSError, UnicodeDecodeError) as e:
                debug_warning(
                    "worktree",
                    f"Could not extract spec summary for PR body: {e}",
                )

        # ── build rich markdown body ──────────────────────────────────
        summary_text = raw_summary or _wt("fallback_footer")

        parts = [
            f"## 🤖 {_wt('summary_section')}",
            "",
            summary_text,
            "",
            f"### ✅ {_wt('checklist_section')}",
            f"- [ ] {_wt('check_standards')}",
            f"- [ ] {_wt('check_tests')}",
            f"- [ ] {_wt('check_docs')}",
            f"- [ ] {_wt('check_coherent')}",
            f"- [ ] {_wt('check_regression')}",
            "",
            "---",
            f"⚠️ **{_wt('warning')}**",
            "",
            f"_{_wt('footer')}_",
        ]

        return "\n".join(parts)

    def _get_existing_pr_url(self, spec_name: str, target_branch: str) -> str | None:
        """Get the URL of an existing PR for this branch."""
        info = self.get_worktree_info(spec_name)
        if not info:
            return None

        gh_executable = get_gh_executable()
        if not gh_executable:
            # gh CLI not found - return None and let caller handle it
            return None

        try:
            result = subprocess.run(
                [
                    gh_executable,
                    "pr",
                    "view",
                    info.branch,
                    "--json",
                    "url",
                    "--jq",
                    ".url",
                ],
                cwd=info.path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.CLI_QUERY_TIMEOUT,
                env=get_isolated_git_env(),
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (
            subprocess.TimeoutExpired,
            FileNotFoundError,
            subprocess.SubprocessError,
        ) as e:
            # Silently ignore errors when fetching existing PR URL - this is a best-effort
            # lookup that may fail due to network issues, missing gh CLI, or auth problems.
            # Returning None allows the caller to handle missing URLs gracefully.
            if isinstance(e, FileNotFoundError):
                invalidate_gh_cache()
            debug_warning("worktree", f"Could not get existing PR URL: {e}")

        return None

    def _get_existing_mr_url(self, spec_name: str, target_branch: str) -> str | None:
        """Get the URL of an existing MR for this branch."""
        info = self.get_worktree_info(spec_name)
        if not info:
            return None

        glab_executable = get_glab_executable()
        if not glab_executable:
            # glab CLI not found - return None and let caller handle it
            return None

        try:
            result = subprocess.run(
                [
                    glab_executable,
                    "mr",
                    "view",
                    info.branch,
                    "--output",
                    "json",
                ],
                cwd=info.path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.CLI_QUERY_TIMEOUT,
                env=get_isolated_git_env(),
            )
            if result.returncode == 0 and result.stdout.strip():
                # Parse JSON output to extract web_url (glab uses snake_case)
                try:
                    data = json.loads(result.stdout)
                    return data.get("web_url")
                except json.JSONDecodeError:
                    # If JSON parsing fails, return None
                    pass
        except (
            subprocess.TimeoutExpired,
            FileNotFoundError,
            subprocess.SubprocessError,
        ) as e:
            # Silently ignore errors when fetching existing MR URL - this is a best-effort
            # lookup that may fail due to network issues, missing glab CLI, or auth problems.
            # Returning None allows the caller to handle missing URLs gracefully.
            if isinstance(e, FileNotFoundError):
                invalidate_glab_cache()
            debug_warning("worktree", f"Could not get existing MR URL: {e}")

        return None

    def _get_existing_azure_pr_url(
        self, spec_name: str, target_branch: str | None = None
    ) -> str | None:
        """Best-effort lookup of an existing open Azure DevOps PR for this branch.

        Mirrors the existing-PR probe inside ``create_azure_pull_request`` but
        as a standalone read-only query, so a redundant push can be skipped
        when the PR already exists. A read (GET) often still succeeds when
        ``git push`` is rejected with 403 (e.g. a read-scoped PAT). Never raises.
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            return None

        org = extract_azure_devops_org(self.project_dir)
        project = extract_azure_devops_project(self.project_dir)
        repository = extract_azure_devops_repository(self.project_dir)
        if not (org and project and repository):
            return None

        creds = self._get_azure_devops_credentials()
        if not creds:
            return None

        target = target_branch or self.base_branch
        try:
            from urllib.parse import quote

            import requests

            project_encoded = quote(project, safe="")
            repository_encoded = quote(repository, safe="")
            base_url = (
                f"https://dev.azure.com/{quote(org, safe='')}/{project_encoded}"
                f"/_apis/git/repositories/{repository_encoded}"
            )
            search_url = (
                f"{base_url}/pullrequests?api-version=7.1"
                f"&searchCriteria.sourceRefName=refs/heads/{info.branch}"
                f"&searchCriteria.targetRefName=refs/heads/{target}"
                f"&searchCriteria.status=active"
            )
            resp = requests.get(search_url, auth=creds, timeout=30)
            if resp.status_code == 200:
                prs = resp.json().get("value", [])
                if prs:
                    pr_id = prs[0].get("pullRequestId")
                    return (
                        f"https://dev.azure.com/{quote(org, safe='')}"
                        f"/{project_encoded}/_git/{repository_encoded}"
                        f"/pullrequest/{pr_id}"
                    )
        except Exception as e:
            debug_warning("worktree", f"Could not get existing Azure PR URL: {e}")

        return None

    def find_existing_pr_url(
        self, spec_name: str, target_branch: str | None = None
    ) -> str | None:
        """Return the URL of an existing open PR/MR for this spec's branch, or None.

        Provider-aware and best-effort — used to finalize a task without a
        redundant push when the PR already exists. Never raises.
        """
        try:
            provider = detect_git_provider(self.project_dir)
        except Exception:
            provider = None

        if provider == "azure_devops":
            return self._get_existing_azure_pr_url(spec_name, target_branch)
        if provider == "gitlab":
            return self._get_existing_mr_url(spec_name, target_branch)
        # Default to GitHub (gh CLI handles the common case).
        return self._get_existing_pr_url(spec_name, target_branch)

    def _apply_discard_list(self, spec_name: str, target_branch: str) -> list[str]:
        """Applique la ``.workpilot-discard-list`` au worktree avant le push.

        L'UI affiche un diff filtré (``origin/base...origin/head`` moins les
        fichiers présents dans ``.workpilot-discard-list``). Sans cette étape,
        la branche poussée contient toujours les commits d'origine et la PR
        embarque les fichiers abandonnés : il y a décorrélation entre l'aperçu
        et la PR.

        Pour chaque fichier abandonné, on aligne la HEAD du worktree sur la
        branche cible :
        - fichier présent dans la cible -> ``git checkout <cible> -- <fichier>``
          (annule les modifications de la tâche) ;
        - fichier ajouté par la tâche (absent de la cible) -> ``git rm`` (on le
          retire complètement).

        ``git checkout``/``git rm`` mettent déjà à jour l'index : on commit donc
        uniquement ces changements, sans ``git add -A``, pour éviter d'inclure
        ``.workpilot-discard-list`` elle-même dans la PR.

        Args:
            spec_name: Nom du dossier spec (worktree).
            target_branch: Branche cible de la PR (ex: ``develop``).

        Returns:
            Liste des fichiers effectivement réappliqués (revertés).
        """
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return []

        discard_path = worktree_path / ".workpilot-discard-list"
        if not discard_path.exists():
            return []

        try:
            discarded = [
                line.strip()
                for line in discard_path.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]
        except OSError as exc:
            logger.warning("[_apply_discard_list] Cannot read discard list: %s", exc)
            return []

        if not discarded:
            return []

        # Résout la ref qui contient le contenu "cible" : préfère
        # origin/<target> si présent (aligné avec la PR), sinon <target>.
        base_ref = target_branch
        remote_ref = f"origin/{target_branch}"
        if (
            self._run_git(
                ["rev-parse", "--verify", "--quiet", remote_ref], cwd=worktree_path
            ).returncode
            == 0
        ):
            base_ref = remote_ref

        reverted: list[str] = []
        for rel_path in discarded:
            exists_in_base = (
                self._run_git(
                    ["cat-file", "-e", f"{base_ref}:{rel_path}"], cwd=worktree_path
                ).returncode
                == 0
            )
            if exists_in_base:
                res = self._run_git(
                    ["checkout", base_ref, "--", rel_path], cwd=worktree_path
                )
            else:
                res = self._run_git(
                    ["rm", "-f", "--ignore-unmatch", "--", rel_path],
                    cwd=worktree_path,
                )

            if res.returncode == 0:
                reverted.append(rel_path)
            else:
                logger.warning(
                    "[_apply_discard_list] Failed to revert %s against %s: %s",
                    rel_path,
                    base_ref,
                    res.stderr,
                )

        if reverted:
            commit = self._run_git(
                [
                    "commit",
                    "-m",
                    f"workpilot: exclude {len(reverted)} user-discarded file(s)",
                ],
                cwd=worktree_path,
            )
            if commit.returncode != 0 and "nothing to commit" not in (
                commit.stdout + commit.stderr
            ):
                logger.warning(
                    "[_apply_discard_list] Commit of discarded reverts failed: %s",
                    commit.stderr,
                )

        return reverted

    def push_and_create_pr(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
        force_push: bool = False,
        body: str | None = None,
    ) -> PushAndCreatePRResult:
        """
        Push branch and create a pull request/merge request in one operation.
        Automatically detects git provider (GitHub or GitLab) and routes to the appropriate CLI.

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for PR/MR (defaults to base_branch)
            title: PR/MR title (defaults to spec name)
            draft: Whether to create as draft PR/MR
            force_push: Whether to force push the branch
            body: Optional PR/MR body. If provided, used verbatim (no AI
                  generation, no impact block injection) - the caller is
                  responsible for the full content including any impact block.

        Returns:
            PushAndCreatePRResult with keys:
                - success: bool
                - pr_url: str (if created)
                - pushed: bool (if push succeeded)
                - provider: str ('github', 'gitlab', or 'unknown')
                - already_exists: bool (if PR/MR already exists)
                - error: str (if failed)
        """
        # Step 0: Commit any uncommitted changes before pushing
        has_changes, changed_files = self._has_uncommitted_changes(spec_name)
        if has_changes:
            logger.info(
                f"[push_and_create_pr] Found {len(changed_files)} uncommitted files in '{spec_name}', committing..."
            )
            commit_msg = title or f"auto-claude: {spec_name}"
            self.commit_in_worktree(spec_name, commit_msg)

        # Step 0.4: Applique la discard list pour que la branche poussée
        # corresponde exactement au diff filtré affiché dans l'UI. Sans cela,
        # les fichiers abandonnés par l'utilisateur (présents uniquement dans
        # .workpilot-discard-list, un filtre d'affichage) resteraient dans les
        # commits et seraient embarqués dans la PR -> décorrélation.
        effective_target = target_branch or self.base_branch
        reverted = self._apply_discard_list(spec_name, effective_target)
        if reverted:
            logger.info(
                "[push_and_create_pr] Applied discard list: excluded %d file(s) "
                "from '%s' before push.",
                len(reverted),
                spec_name,
            )

        # Step 0.45: Retire les artefacts internes de WorkPilot (.workpilot/,
        # .workpilot-*) de la branche pour ne jamais polluer la PR. Gère le cas
        # où l'agent les aurait déjà commités pendant son travail.
        stripped = self._strip_workpilot_artifacts(spec_name)
        if stripped:
            logger.info(
                "[push_and_create_pr] Stripped %d WorkPilot artifact(s) from "
                "'%s' before push.",
                len(stripped),
                spec_name,
            )

        # Step 0.5: Garde-fou contre la création d'une PR vide.
        # Si la branche du worktree n'a aucun commit en avance de la cible,
        # la PR créée serait vide (cas typique : tâche dupliquée déjà mergée
        # via une autre branche, ou agent qui n'a rien commité). On échoue
        # explicitement avec un message exploitable côté UI plutôt que de
        # pousser silencieusement une PR sans contenu.
        ahead = self._count_commits_ahead(spec_name, effective_target)
        if ahead == 0:
            logger.warning(
                "[push_and_create_pr] Refusing to create empty PR: branch for "
                "spec '%s' has 0 commits ahead of '%s'.",
                spec_name,
                effective_target,
            )
            return PushAndCreatePRResult(
                success=False,
                pushed=False,
                branch="",
                remote="",
                error=(
                    f"Aucun commit à pousser : la branche du worktree est "
                    f"identique à '{effective_target}'. Vérifiez que l'agent "
                    f"a bien commité ses changements, ou que le travail n'a "
                    f"pas déjà été fusionné via une autre branche (tâche "
                    f"dupliquée)."
                ),
            )

        # Step 1: Push the branch
        push_result = self.push_branch(spec_name, force=force_push)
        if not push_result.get("success"):
            return PushAndCreatePRResult(
                success=False,
                pushed=False,
                branch=push_result.get("branch", ""),
                remote=push_result.get("remote", ""),
                error=push_result.get("error", "Push failed"),
            )

        # Step 2: Detect git provider (use the remote that was pushed to)
        provider = detect_git_provider(
            self.project_dir, remote_name=push_result.get("remote")
        )

        # Step 3: Create the PR/MR based on provider
        if provider == "azure_devops":
            pr_result = self.create_azure_pull_request(
                spec_name=spec_name,
                target_branch=target_branch,
                title=title,
                draft=draft,
                body=body,
            )
        elif provider == "github":
            pr_result = self.create_pull_request(
                spec_name=spec_name,
                target_branch=target_branch,
                title=title,
                draft=draft,
                body=body,
            )
        elif provider == "gitlab":
            pr_result = self.create_merge_request(
                spec_name=spec_name,
                target_branch=target_branch,
                title=title,
                draft=draft,
                body=body,
            )
        else:
            # Unknown provider
            return PushAndCreatePRResult(
                success=False,
                pushed=True,
                remote=push_result.get("remote"),
                branch=push_result.get("branch"),
                provider=provider,
                error="Unable to determine git hosting provider. Supported: GitHub, GitLab, Azure DevOps.",
            )

        # Combine results
        return PushAndCreatePRResult(
            success=pr_result.get("success", False),
            pushed=True,
            remote=push_result.get("remote"),
            branch=push_result.get("branch"),
            provider=provider,
            pr_url=pr_result.get("pr_url"),
            already_exists=pr_result.get("already_exists", False),
            error=pr_result.get("error"),
        )
