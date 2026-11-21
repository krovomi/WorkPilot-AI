"""
Azure DevOps PR Review Engine
===============================

Core logic for AI-powered PR review on Azure DevOps.
Mirrors the GitLab MR review engine pattern.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from core.io_utils import safe_print

from ..models import (
    AzDOPRContext,
    AzureDevOpsRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    ReviewCategory,
    ReviewSeverity,
)

# From least to most strict: a verdict is never relaxed by another signal.
_VERDICT_ORDER = (
    MergeVerdict.READY_TO_MERGE,
    MergeVerdict.MERGE_WITH_CHANGES,
    MergeVerdict.NEEDS_REVISION,
    MergeVerdict.BLOCKED,
)

from runners.forge_review_prompt import change_context

#: The backend's own reviewer prompts; the project under review never supplies them.
_PROMPTS_DIR = Path(__file__).resolve().parents[3] / "prompts" / "github"


@dataclass
class ProgressCallback:
    """Callback for progress updates."""

    phase: str
    progress: int
    message: str
    pr_id: int | None = None


class PRReviewEngine:
    """
    AI-powered PR review engine for Azure DevOps.

    Uses the Claude Agent SDK to analyze PRs and produce
    structured findings with deep codebase context.
    """

    def __init__(
        self,
        project_dir: Path,
        azdo_dir: Path,
        config: AzureDevOpsRunnerConfig,
        progress_callback: Callable | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.azdo_dir = azdo_dir
        self.config = config
        self.progress_callback = progress_callback

    def _report_progress(
        self, phase: str, progress: int, message: str, pr_id: int | None = None
    ):
        if self.progress_callback:
            self.progress_callback(
                ProgressCallback(
                    phase=phase, progress=progress, message=message, pr_id=pr_id
                )
            )

    def _get_review_prompt(self) -> str:
        """Load the PR reviewer prompt that ships with the app."""
        prompt_file = _PROMPTS_DIR / "pr_reviewer.md"
        if prompt_file.is_file():
            return prompt_file.read_text(encoding="utf-8")

        # Fallback inline prompt
        return """You are an expert code reviewer. Analyze the pull request and provide structured findings.

For each issue found, respond with a JSON array of findings:
```json
[
  {
    "severity": "critical|high|medium|low",
    "category": "security|quality|style|test|docs|pattern|performance",
    "title": "Short title",
    "description": "Detailed description",
    "file": "path/to/file",
    "line": 1,
    "suggested_fix": "How to fix (optional)"
  }
]
```

Also provide:
- verdict: "ready_to_merge", "merge_with_changes", "needs_revision", or "blocked"
- verdict_reasoning: Brief explanation
- blockers: List of blocking issues (if any)
- summary: Overall review summary
"""

    def _build_pr_context(self, context: AzDOPRContext) -> str:
        """The pull request as the reviewer sees it, every field quoted as data."""
        return change_context(
            heading=f"Pull Request #{int(context.pr_id)}",
            title=context.title,
            description=context.description,
            author=context.author,
            source_branch=context.source_branch,
            target_branch=context.target_branch,
            file_paths=[file.get("path", "unknown") for file in context.changed_files],
            diff=context.diff,
            additions=context.total_additions,
            deletions=context.total_deletions,
            source=f"azure_devops:pr#{context.pr_id}",
            spec_dir=self.azdo_dir,
        )

    async def run_review(
        self, context: AzDOPRContext
    ) -> tuple[list[PRReviewFinding], MergeVerdict, str, list[str]]:
        """
        Run the PR review.

        Returns:
            Tuple of (findings, verdict, summary, blockers)
        """
        from core.client import create_agent_client

        self._report_progress(
            "analyzing", 30, "Running AI analysis...", pr_id=context.pr_id
        )

        pr_context = self._build_pr_context(context)

        # Inject deep codebase context if available
        deep_context_section = ""
        if context.deep_context:
            from ...github.services.deep_context_provider import DeepContext

            dc = DeepContext.from_dict(context.deep_context)
            deep_context_section = dc.to_prompt_section()

        prompt = self._get_review_prompt() + "\n\n---\n\n"
        if deep_context_section:
            prompt += deep_context_section + "\n\n---\n\n"
        prompt += pr_context
        from integrations.jev.reviews import context_advice

        if advice := context_advice(context):
            prompt += "\n\n" + advice

        # The reviewer reads the project it reviews, and nothing above it.
        client = create_agent_client(
            project_dir=self.project_dir,
            spec_dir=self.azdo_dir,
            model=self.config.model,
            agent_type="pr_reviewer",
        )

        from core.agent_client import ContentBlockType

        result_text = ""
        try:
            async with client:
                await client.query(prompt)
                async for msg in client.receive_response():
                    for block in msg.content:
                        if block.type == ContentBlockType.TEXT and block.text:
                            result_text += block.text
        except Exception as e:
            # A review that did not run must not read as an approval.
            safe_print(f"[AzDO] Review failed: {e}")
            raise RuntimeError(f"Review failed: {e}") from e

        # Parse the response
        return self._parse_review_response(result_text)

    def _parse_review_response(
        self, response: str
    ) -> tuple[list[PRReviewFinding], MergeVerdict, str, list[str]]:
        """Parse structured review response."""
        findings = []
        verdict = MergeVerdict.READY_TO_MERGE
        summary = ""
        blockers = []

        # Try to extract JSON from response
        json_blocks = re.findall(r"```(?:json)?\s*\n(.*?)```", response, re.DOTALL)

        for block in json_blocks:
            try:
                parsed = json.loads(block.strip())
                if isinstance(parsed, list):
                    for item in parsed:
                        if not isinstance(item, dict):
                            continue
                        try:
                            finding = PRReviewFinding(
                                id=f"azdo-{uuid.uuid4().hex[:8]}",
                                severity=ReviewSeverity(item.get("severity", "low")),
                                category=ReviewCategory(
                                    item.get("category", "quality")
                                ),
                                title=item.get("title", ""),
                                description=item.get("description", ""),
                                file=item.get("file", "unknown"),
                                line=item.get("line", 0),
                                end_line=item.get("end_line"),
                                suggested_fix=item.get("suggested_fix"),
                                fixable=item.get("fixable", False),
                                evidence=item.get("evidence"),
                            )
                            findings.append(finding)
                        except (ValueError, KeyError):
                            continue
                elif isinstance(parsed, dict):
                    if "verdict" in parsed:
                        try:
                            verdict = MergeVerdict(parsed["verdict"])
                        except ValueError:
                            pass
                    summary = parsed.get("summary", summary)
                    blockers = parsed.get("blockers", blockers)
            except json.JSONDecodeError:
                continue

        # The findings set a floor: the stricter of the stated verdict and
        # the one their severities call for wins.
        severities = {f.severity for f in findings}
        if ReviewSeverity.CRITICAL in severities:
            floor = MergeVerdict.BLOCKED
        elif severities & {ReviewSeverity.HIGH, ReviewSeverity.MEDIUM}:
            floor = MergeVerdict.NEEDS_REVISION
        else:
            floor = MergeVerdict.READY_TO_MERGE
        verdict = max(verdict, floor, key=_VERDICT_ORDER.index)

        # Extract summary from non-JSON part of response
        if not summary:
            lines = response.split("\n")
            non_json_lines = []
            in_json = False
            for line in lines:
                if line.strip().startswith("```"):
                    in_json = not in_json
                    continue
                if not in_json:
                    non_json_lines.append(line)
            summary = "\n".join(non_json_lines[:20]).strip()

        return findings, verdict, summary, blockers

    def generate_summary(
        self,
        findings: list[PRReviewFinding],
        verdict: MergeVerdict,
        verdict_reasoning: str,
        blockers: list[str],
    ) -> str:
        """Generate a human-readable review summary."""
        severity_counts = {}
        for f in findings:
            severity_counts[f.severity.value] = (
                severity_counts.get(f.severity.value, 0) + 1
            )

        parts = []

        # Verdict header
        verdict_labels = {
            MergeVerdict.READY_TO_MERGE: "READY TO MERGE",
            MergeVerdict.MERGE_WITH_CHANGES: "MERGE WITH MINOR CHANGES",
            MergeVerdict.NEEDS_REVISION: "NEEDS REVISION",
            MergeVerdict.BLOCKED: "BLOCKED",
        }
        parts.append(f"**{verdict_labels.get(verdict, verdict.value)}**")

        if verdict_reasoning:
            parts.append(f"\n{verdict_reasoning}")

        # Severity breakdown
        if severity_counts:
            breakdown = ", ".join(
                f"{count} {sev}" for sev, count in severity_counts.items()
            )
            parts.append(f"\n**Findings:** {breakdown}")

        # Blockers
        if blockers:
            parts.append("\n**Blockers:**")
            for blocker in blockers:
                parts.append(f"- {blocker}")

        return "\n".join(parts)
