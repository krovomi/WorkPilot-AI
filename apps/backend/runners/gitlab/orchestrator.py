"""
GitLab Automation Orchestrator
==============================

Main coordinator for GitLab automation workflows:
- MR Review: AI-powered merge request review
- Follow-up Review: Review changes since last review
"""

from __future__ import annotations

import json
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from core.io_utils import safe_print

from ..github.services.deep_context_provider import (
    DeepContextProvider,
    store_review_learnings,
)
from .glab_client import GitLabAPIError, GitLabClient, GitLabConfig
from .models import (
    GitLabRunnerConfig,
    MergeVerdict,
    MRContext,
    MRReviewResult,
)
from .services import MRReviewEngine


@dataclass
class ProgressCallback:
    """Callback for progress updates."""

    phase: str
    progress: int  # 0-100
    message: str
    mr_iid: int | None = None


def _overall_status(verdict: MergeVerdict) -> str:
    """The MR action a verdict calls for: approve, comment or request changes."""
    if verdict in (MergeVerdict.BLOCKED, MergeVerdict.NEEDS_REVISION):
        return "request_changes"
    if verdict == MergeVerdict.MERGE_WITH_CHANGES:
        return "comment"
    return "approve"


def _api_error_message(error: GitLabAPIError, mr_iid: int) -> str:
    """What the user is told when a GitLab request fails."""
    if error.status is None:
        return str(error)
    return {
        401: "GitLab authentication failed. Check your token.",
        403: "GitLab access forbidden. Check your permissions.",
        404: f"MR !{mr_iid} not found in GitLab.",
        429: "GitLab rate limit exceeded. Please try again later.",
    }.get(error.status, f"GitLab API error {error.status}")


def _changed_paths(context: MRContext) -> list[str]:
    return [
        f.get("new_path", f.get("old_path", ""))
        for f in context.changed_files
        if f.get("new_path") or f.get("old_path")
    ]


class GitLabOrchestrator:
    """
    Orchestrates GitLab automation workflows.

    Usage:
        orchestrator = GitLabOrchestrator(
            project_dir=Path("/path/to/project"),
            config=config,
        )

        # Review an MR
        result = await orchestrator.review_mr(mr_iid=123)
    """

    def __init__(
        self,
        project_dir: Path,
        config: GitLabRunnerConfig,
        progress_callback: Callable[[ProgressCallback], None] | None = None,
    ):
        self.project_dir = Path(project_dir)
        from integrations.jev.models import JevContext
        from integrations.jev.runtime import JevRun

        self._jev_worker = JevRun.from_env(
            JevContext("gitlab-review", self.project_dir)
        )
        self.config = config
        self.progress_callback = progress_callback

        # GitLab directory for storing state
        self.gitlab_dir = self.project_dir / ".workpilot" / "gitlab"
        self.gitlab_dir.mkdir(parents=True, exist_ok=True)

        # Load GitLab config
        self.gitlab_config = GitLabConfig(
            token=config.token,
            project=config.project,
            instance_url=config.instance_url,
        )

        # Initialize client
        self.client = GitLabClient(
            project_dir=self.project_dir,
            config=self.gitlab_config,
        )

        # Initialize deep context provider (shared with GitHub)
        self.deep_context_provider = DeepContextProvider(project_dir=self.project_dir)

        # Initialize review engine
        self.review_engine = MRReviewEngine(
            project_dir=self.project_dir,
            gitlab_dir=self.gitlab_dir,
            config=self.config,
            progress_callback=self._forward_progress,
        )

    def _report_progress(
        self,
        phase: str,
        progress: int,
        message: str,
        mr_iid: int | None = None,
    ) -> None:
        """Report progress to callback if set."""
        if self.progress_callback:
            self.progress_callback(
                ProgressCallback(
                    phase=phase,
                    progress=progress,
                    message=message,
                    mr_iid=mr_iid,
                )
            )

    def _forward_progress(self, callback) -> None:
        """Forward progress from engine to orchestrator callback."""
        if self.progress_callback:
            self.progress_callback(callback)

    def _failed(self, mr_iid: int, error: str, **extra) -> MRReviewResult:
        """Record a review that could not be completed, and return it."""
        result = MRReviewResult(
            mr_iid=mr_iid,
            project=self.config.project,
            success=False,
            error=error,
            **extra,
        )
        result.save(self.gitlab_dir)
        return result

    async def _gather_mr_context(self, mr_iid: int) -> MRContext:
        """Gather context for an MR."""
        safe_print(f"[GitLab] Fetching MR !{mr_iid} data...")

        # Get MR details
        mr_data = self.client.get_mr(mr_iid)

        # Get changes
        changes_data = self.client.get_mr_changes(mr_iid)

        # Get commits
        commits = self.client.get_mr_commits(mr_iid)

        # Build diff from changes
        diffs = []
        total_additions = 0
        total_deletions = 0
        changed_files = []

        for change in changes_data.get("changes", []):
            diff = change.get("diff", "")
            if diff:
                diffs.append(diff)

            # Count lines
            for line in diff.split("\n"):
                if line.startswith("+") and not line.startswith("+++"):
                    total_additions += 1
                elif line.startswith("-") and not line.startswith("---"):
                    total_deletions += 1

            changed_files.append(
                {
                    "new_path": change.get("new_path"),
                    "old_path": change.get("old_path"),
                    "diff": diff,
                }
            )

        # Get head SHA
        head_sha = mr_data.get("sha") or (mr_data.get("diff_refs") or {}).get(
            "head_sha"
        )

        return MRContext(
            mr_iid=mr_iid,
            title=mr_data.get("title", ""),
            description=mr_data.get("description") or "",
            author=(mr_data.get("author") or {}).get("username", "unknown"),
            source_branch=mr_data.get("source_branch", ""),
            target_branch=mr_data.get("target_branch", ""),
            state=mr_data.get("state", "opened"),
            changed_files=changed_files,
            diff="\n".join(diffs),
            total_additions=total_additions,
            total_deletions=total_deletions,
            commits=commits,
            head_sha=head_sha,
        )

    async def review_mr(self, mr_iid: int) -> MRReviewResult:
        """
        Perform AI-powered review of a merge request.

        Args:
            mr_iid: The MR IID to review

        Returns:
            MRReviewResult with findings and overall assessment
        """
        safe_print(f"[GitLab] Starting review for MR !{mr_iid}")

        self._report_progress(
            "gathering_context",
            10,
            f"Gathering context for MR !{mr_iid}...",
            mr_iid=mr_iid,
        )

        try:
            # Gather MR context
            context = await self._gather_mr_context(mr_iid)
            safe_print(
                f"[GitLab] Context gathered: {context.title} "
                f"({len(context.changed_files)} files, {context.total_additions}+/{context.total_deletions}-)"
            )

            # Gather deep codebase context (non-blocking)
            try:
                deep_ctx = await self.deep_context_provider.gather_deep_context(
                    pr_title=context.title,
                    pr_description=context.description,
                    changed_file_paths=_changed_paths(context),
                    timeout=20.0,
                )
                context.deep_context = deep_ctx.to_dict()
                safe_print(
                    f"[GitLab] Deep context: patterns={len(deep_ctx.project_patterns)}, "
                    f"insights={len(deep_ctx.historical_insights)}, "
                    f"arch_violations={len(deep_ctx.architecture_violations)}"
                )
            except Exception as e:
                safe_print(
                    f"[GitLab] Deep context gathering failed (non-blocking): {e}"
                )

            self._report_progress(
                "analyzing", 30, "Running AI review...", mr_iid=mr_iid
            )

            # Run review
            from integrations.jev.reviews import evaluate_context

            jev_observation = await evaluate_context(self._jev_worker, context)
            findings, verdict, summary, blockers = await self.review_engine.run_review(
                context
            )
            safe_print(f"[GitLab] Review complete: {len(findings)} findings")

            # Generate summary
            full_summary = self.review_engine.generate_summary(
                findings=findings,
                verdict=verdict,
                verdict_reasoning=summary,
                blockers=blockers,
            )

            # Create result
            result = MRReviewResult(
                jev=jev_observation,
                mr_iid=mr_iid,
                project=self.config.project,
                success=True,
                findings=findings,
                summary=full_summary,
                overall_status=_overall_status(verdict),
                verdict=verdict,
                verdict_reasoning=summary,
                blockers=blockers,
                reviewed_commit_sha=context.head_sha,
                deep_context=context.deep_context,
            )

            # Save result
            result.save(self.gitlab_dir)

            # Store review learnings in the shared brain (non-blocking)
            if findings:
                try:
                    await store_review_learnings(
                        project_dir=self.project_dir,
                        pr_number=mr_iid,
                        findings=[f.to_dict() for f in findings],
                        pr_title=context.title,
                        changed_files=_changed_paths(context),
                    )
                except Exception as e:
                    safe_print(
                        f"[GitLab] Failed to store review learnings (non-blocking): {e}"
                    )

            self._report_progress("complete", 100, "Review complete!", mr_iid=mr_iid)

            return result

        except GitLabAPIError as e:
            error_msg = _api_error_message(e, mr_iid)
            safe_print(f"[GitLab] Review failed for !{mr_iid}: {error_msg}")
            return self._failed(mr_iid, error_msg)

        except json.JSONDecodeError as e:
            error_msg = f"Invalid JSON response from GitLab: {e}"
            safe_print(f"[GitLab] Review failed for !{mr_iid}: {error_msg}")
            return self._failed(mr_iid, error_msg)

        except Exception as e:
            # Catch-all for unexpected errors, with full traceback for debugging
            error_details = f"{type(e).__name__}: {e}"
            full_traceback = traceback.format_exc()
            safe_print(f"[GitLab] Review failed for !{mr_iid}: {error_details}")
            safe_print(f"[GitLab] Traceback:\n{full_traceback}")
            return self._failed(
                mr_iid, f"{error_details}\n\nTraceback:\n{full_traceback}"
            )

    async def followup_review_mr(self, mr_iid: int) -> MRReviewResult:
        """
        Perform a follow-up review of an MR.

        Only reviews changes since the last review.

        Args:
            mr_iid: The MR IID to review

        Returns:
            MRReviewResult with follow-up analysis
        """
        safe_print(f"[GitLab] Starting follow-up review for MR !{mr_iid}")

        # Load previous review
        previous_review = MRReviewResult.load(self.gitlab_dir, mr_iid)

        if not previous_review:
            raise ValueError(
                f"No previous review found for MR !{mr_iid}. Run initial review first."
            )

        if not previous_review.reviewed_commit_sha:
            raise ValueError(
                f"Previous review for MR !{mr_iid} doesn't have commit SHA. "
                "Re-run initial review."
            )

        self._report_progress(
            "gathering_context",
            10,
            f"Gathering follow-up context for MR !{mr_iid}...",
            mr_iid=mr_iid,
        )

        try:
            # Get current MR state
            context = await self._gather_mr_context(mr_iid)

            # Check if there are new commits
            if context.head_sha == previous_review.reviewed_commit_sha:
                print(
                    f"[GitLab] No new commits since last review at {previous_review.reviewed_commit_sha[:8]}",
                    flush=True,
                )
                result = MRReviewResult(
                    mr_iid=mr_iid,
                    project=self.config.project,
                    success=True,
                    findings=previous_review.findings,
                    summary="No new commits since last review. Previous findings still apply.",
                    overall_status=previous_review.overall_status,
                    verdict=previous_review.verdict,
                    verdict_reasoning="No changes since last review.",
                    reviewed_commit_sha=context.head_sha,
                    is_followup_review=True,
                    unresolved_findings=[f.id for f in previous_review.findings],
                )
                result.save(self.gitlab_dir)
                return result

            self._report_progress(
                "analyzing",
                30,
                "Analyzing changes since last review...",
                mr_iid=mr_iid,
            )

            # Run full review on current state
            from integrations.jev.reviews import evaluate_context

            jev_observation = await evaluate_context(self._jev_worker, context)
            findings, verdict, summary, blockers = await self.review_engine.run_review(
                context
            )

            # Compare with previous findings
            previous_finding_titles = {f.title for f in previous_review.findings}
            current_finding_titles = {f.title for f in findings}

            resolved = previous_finding_titles - current_finding_titles
            unresolved = previous_finding_titles & current_finding_titles
            new_findings = current_finding_titles - previous_finding_titles

            # Generate summary
            full_summary = self.review_engine.generate_summary(
                findings=findings,
                verdict=verdict,
                verdict_reasoning=summary,
                blockers=blockers,
            )

            # Add follow-up info
            full_summary = f"""### Follow-up Review

**Resolved**: {len(resolved)} finding(s)
**Still Open**: {len(unresolved)} finding(s)
**New Issues**: {len(new_findings)} finding(s)

---

{full_summary}"""

            result = MRReviewResult(
                jev=jev_observation,
                mr_iid=mr_iid,
                project=self.config.project,
                success=True,
                findings=findings,
                summary=full_summary,
                overall_status=_overall_status(verdict),
                verdict=verdict,
                verdict_reasoning=summary,
                blockers=blockers,
                reviewed_commit_sha=context.head_sha,
                is_followup_review=True,
                resolved_findings=list(resolved),
                unresolved_findings=list(unresolved),
                new_findings_since_last_review=list(new_findings),
            )

            result.save(self.gitlab_dir)

            self._report_progress(
                "complete", 100, "Follow-up review complete!", mr_iid=mr_iid
            )

            return result

        except GitLabAPIError as e:
            error_msg = _api_error_message(e, mr_iid)
            print(
                f"[GitLab] Follow-up review failed for !{mr_iid}: {error_msg}",
                flush=True,
            )
            return self._failed(mr_iid, error_msg, is_followup_review=True)

        except json.JSONDecodeError as e:
            error_msg = f"Invalid JSON response from GitLab: {e}"
            print(
                f"[GitLab] Follow-up review failed for !{mr_iid}: {error_msg}",
                flush=True,
            )
            return self._failed(mr_iid, error_msg, is_followup_review=True)

        except Exception as e:
            # Catch-all for unexpected errors
            error_details = f"{type(e).__name__}: {e}"
            print(
                f"[GitLab] Follow-up review failed for !{mr_iid}: {error_details}",
                flush=True,
            )
            return self._failed(mr_iid, error_details, is_followup_review=True)
