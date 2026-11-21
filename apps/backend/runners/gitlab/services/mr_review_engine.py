"""
MR Review Engine
================

Core logic for AI-powered MR code review.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from core.io_utils import safe_print
from runners.forge_review_prompt import change_context

from ...github.services.deep_context_provider import DeepContext
from ..models import (
    GitLabRunnerConfig,
    MergeVerdict,
    MRContext,
    MRReviewFinding,
    ReviewCategory,
    ReviewSeverity,
)


@dataclass
class ProgressCallback:
    """Callback for progress updates."""

    phase: str
    progress: int
    message: str
    mr_iid: int | None = None


# What the review says when the model's answer holds no readable review: the
# MR is neither approved nor blocked on an answer nobody could read.
_UNPARSED_SUMMARY = (
    "Review completed but failed to parse structured output. Please re-run the review."
)


def sanitize_user_content(content: str, max_length: int = 100000) -> str:
    """
    Sanitize user-provided content to prevent prompt injection.

    - Strips null bytes and control characters (except newlines/tabs)
    - Truncates excessive length
    """
    if not content:
        return ""

    # Remove null bytes and control characters (except newline, tab, carriage return)
    sanitized = "".join(
        char
        for char in content
        if char == "\n"
        or char == "\t"
        or char == "\r"
        or (ord(char) >= 32 and ord(char) != 127)
    )

    # Truncate if too long
    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length] + "\n\n... (content truncated for length)"

    return sanitized


class MRReviewEngine:
    """Handles MR review workflow using Claude AI."""

    progress_callback: Callable[[ProgressCallback], None] | None

    def __init__(
        self,
        project_dir: Path,
        gitlab_dir: Path,
        config: GitLabRunnerConfig,
        progress_callback: Callable[[ProgressCallback], None] | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.gitlab_dir = Path(gitlab_dir)
        self.config = config
        self.progress_callback = progress_callback

    def _report_progress(self, phase: str, progress: int, message: str, **kwargs):
        """Report progress if callback is set."""
        if self.progress_callback:
            self.progress_callback(
                ProgressCallback(
                    phase=phase, progress=progress, message=message, **kwargs
                )
            )

    def _get_review_prompt(self) -> str:
        """Get the MR review prompt."""
        return """You are a senior code reviewer analyzing a GitLab Merge Request.

Your task is to review the code changes and provide actionable feedback.

## Review Guidelines

1. **Security** - Look for vulnerabilities, injection risks, authentication issues
2. **Quality** - Check for bugs, error handling, edge cases
3. **Style** - Consistent naming, formatting, best practices
4. **Tests** - Are changes tested? Test coverage concerns?
5. **Performance** - Potential performance issues, inefficient algorithms
6. **Documentation** - Are changes documented? Comments where needed?

## Output Format

Provide your review in the following JSON format:

```json
{
  "summary": "Brief overall assessment of the MR",
  "verdict": "ready_to_merge|merge_with_changes|needs_revision|blocked",
  "verdict_reasoning": "Why this verdict",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|quality|style|test|docs|pattern|performance",
      "title": "Brief title",
      "description": "Detailed explanation of the issue",
      "file": "path/to/file.ts",
      "line": 42,
      "end_line": 45,
      "suggested_fix": "Optional code fix suggestion",
      "fixable": true
    }
  ]
}
```

## Important Notes

- Be specific about file and line numbers
- Provide actionable suggestions
- Don't flag style issues that are project conventions
- Focus on real issues, not nitpicks
- Critical and high severity issues should be genuine blockers
"""

    def _build_mr_context(self, context: MRContext) -> str:
        """The merge request as the reviewer sees it, every field quoted as data."""
        return change_context(
            heading=f"Merge Request !{int(context.mr_iid)}",
            title=context.title,
            description=context.description,
            author=context.author,
            source_branch=context.source_branch,
            target_branch=context.target_branch,
            file_paths=[
                file.get("new_path", file.get("old_path", "unknown"))
                for file in context.changed_files
            ],
            diff=context.diff,
            additions=context.total_additions,
            deletions=context.total_deletions,
            source=f"gitlab:mr!{context.mr_iid}",
            spec_dir=self.gitlab_dir,
        )

    async def run_review(
        self, context: MRContext
    ) -> tuple[list[MRReviewFinding], MergeVerdict, str, list[str]]:
        """
        Run the MR review.

        Returns:
            Tuple of (findings, verdict, summary, blockers)
        """
        from core.agent_client import ContentBlockType, MessageRole
        from core.client import create_agent_client

        self._report_progress(
            "analyzing", 30, "Running AI analysis...", mr_iid=context.mr_iid
        )

        mr_context = self._build_mr_context(context)

        # Inject deep codebase context if available
        deep_context_section = ""
        if context.deep_context:
            dc = DeepContext.from_dict(context.deep_context)
            deep_context_section = dc.to_prompt_section()

        prompt = self._get_review_prompt() + "\n\n---\n\n"
        if deep_context_section:
            prompt += deep_context_section + "\n\n---\n\n"
        prompt += mr_context
        from integrations.jev.reviews import context_advice

        if advice := context_advice(context):
            prompt += "\n\n" + advice

        # The reviewer reads the project it reviews, and nothing above it.
        client = create_agent_client(
            project_dir=self.project_dir,
            spec_dir=self.gitlab_dir,
            model=self.config.model,
            agent_type="pr_reviewer",  # Read-only - no bash, no edits
        )

        result_text = ""
        try:
            async with client:
                await client.query(prompt)

                async for msg in client.receive_response():
                    if msg.role != MessageRole.ASSISTANT:
                        continue
                    for block in msg.content:
                        if block.type == ContentBlockType.TEXT and block.text:
                            result_text += block.text

            self._report_progress(
                "analyzing", 70, "Parsing review results...", mr_iid=context.mr_iid
            )

            return self._parse_review_result(result_text)

        except Exception as e:
            safe_print(f"[AI] Review error: {e}")
            raise RuntimeError(f"Review failed: {e}") from e

    def _parse_review_result(
        self, result_text: str
    ) -> tuple[list[MRReviewFinding], MergeVerdict, str, list[str]]:
        """Parse the AI review result.

        An answer with no readable ```json review in it is not an approval:
        the MR gets the cautious verdict and a summary asking for a re-run.
        """
        findings: list[MRReviewFinding] = []
        blockers: list[str] = []

        json_match = re.search(r"```json\s*([\s\S]*?)\s*```", result_text)
        try:
            data = json.loads(json_match.group(1)) if json_match else None
        except json.JSONDecodeError as e:
            safe_print(f"[AI] Failed to parse JSON: {e}")
            data = None
        if not isinstance(data, dict):
            safe_print("[AI] No structured review found in the response")
            safe_print(f"[AI] Raw response (first 500 chars): {result_text[:500]}")
            return findings, MergeVerdict.MERGE_WITH_CHANGES, _UNPARSED_SUMMARY, []

        summary = data.get("summary", "")
        try:
            verdict = MergeVerdict(data.get("verdict", "ready_to_merge"))
        except ValueError:
            verdict = MergeVerdict.READY_TO_MERGE

        for f in data.get("findings", []):
            if not isinstance(f, dict):
                safe_print(f"[AI] Skipping invalid finding: {f!r}")
                continue
            try:
                severity = ReviewSeverity(f.get("severity", "medium"))
                category = ReviewCategory(f.get("category", "quality"))
            except ValueError as e:
                safe_print(f"[AI] Skipping invalid finding: {e}")
                continue

            finding = MRReviewFinding(
                id=f"finding-{uuid.uuid4().hex[:8]}",
                severity=severity,
                category=category,
                title=f.get("title", "Untitled finding"),
                description=f.get("description", ""),
                file=f.get("file", "unknown"),
                line=f.get("line", 1),
                end_line=f.get("end_line"),
                suggested_fix=f.get("suggested_fix"),
                fixable=f.get("fixable", False),
            )
            findings.append(finding)

            # Track blockers
            if severity in (ReviewSeverity.CRITICAL, ReviewSeverity.HIGH):
                blockers.append(f"{finding.title} ({finding.file}:{finding.line})")

        return findings, verdict, summary, blockers

    def generate_summary(
        self,
        findings: list[MRReviewFinding],
        verdict: MergeVerdict,
        verdict_reasoning: str,
        blockers: list[str],
    ) -> str:
        """Generate enhanced summary."""
        verdict_emoji = {
            MergeVerdict.READY_TO_MERGE: "✅",
            MergeVerdict.MERGE_WITH_CHANGES: "🟡",
            MergeVerdict.NEEDS_REVISION: "🟠",
            MergeVerdict.BLOCKED: "🔴",
        }

        lines = [
            f"### Merge Verdict: {verdict_emoji.get(verdict, '⚪')} {verdict.value.upper().replace('_', ' ')}",
            verdict_reasoning,
            "",
        ]

        # Blockers
        if blockers:
            lines.append("### 🚨 Blocking Issues")
            for blocker in blockers:
                lines.append(f"- {blocker}")
            lines.append("")

        # Findings summary
        if findings:
            by_severity = {}
            for f in findings:
                severity = f.severity.value
                if severity not in by_severity:
                    by_severity[severity] = []
                by_severity[severity].append(f)

            lines.append("### Findings Summary")
            for severity in ["critical", "high", "medium", "low"]:
                if severity in by_severity:
                    count = len(by_severity[severity])
                    lines.append(f"- **{severity.capitalize()}**: {count} issue(s)")
            lines.append("")

        lines.append("---")
        lines.append("_Generated by WorkPilot AI MR Review_")

        return "\n".join(lines)
