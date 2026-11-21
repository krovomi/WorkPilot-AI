"""
Triage Engine
=============

Issue triage logic for detecting duplicates, spam, and feature creep.
"""

from __future__ import annotations

from pathlib import Path

from phase_config import resolve_model_id

try:
    from ..models import GitHubRunnerConfig, TriageCategory, TriageResult
    from .prompt_manager import PromptManager
    from .response_parsers import ResponseParser
except (ImportError, ValueError, SystemError):
    # Loaded as a top-level `services` package (the runner's flat layout).
    from runners.github.models import GitHubRunnerConfig, TriageCategory, TriageResult
    from runners.github.services.prompt_manager import PromptManager
    from runners.github.services.response_parsers import ResponseParser


class TriageEngine:
    """Handles issue triage workflow."""

    def __init__(
        self,
        project_dir: Path,
        github_dir: Path,
        config: GitHubRunnerConfig,
        progress_callback=None,
    ):
        self.project_dir = Path(project_dir)
        self.github_dir = Path(github_dir)
        self.config = config
        self.progress_callback = progress_callback
        self.prompt_manager = PromptManager()
        self.parser = ResponseParser()

    async def triage_single_issue(
        self, issue: dict, all_issues: list[dict]
    ) -> TriageResult:
        """Triage a single issue using AI."""
        from core.agent_client import ContentBlockType, MessageRole
        from core.client import create_agent_client

        # Build context with issue and potential duplicates: the closest in
        # meaning when an embedding service is set, else shared title words.
        # Relative under both layouts: this module and it share a package.
        from .duplicate_candidates import potential_duplicates

        dupes = await potential_duplicates(
            issue,
            all_issues,
            repo=self.config.repo,
            cache_dir=self.github_dir / "embeddings",
            project_dir=self.project_dir,
        )
        context = self.build_triage_context(issue, all_issues, potential_dupes=dupes)

        # Load prompt
        prompt = self.prompt_manager.get_triage_prompt()
        full_prompt = prompt + "\n\n---\n\n" + context

        # Run AI
        # Resolve model shorthand (e.g., "sonnet") to full model ID for API compatibility
        model = resolve_model_id(self.config.model or "sonnet")
        client = create_agent_client(
            project_dir=self.project_dir,
            spec_dir=self.github_dir,
            model=model,
            agent_type="issue_triage",
        )

        try:
            async with client:
                await client.query(full_prompt)

                # The agent client yields provider-neutral `AgentMessage`s: the
                # SDK's own class names (AssistantMessage, TextBlock) are gone.
                response_text = ""
                async for msg in client.receive_response():
                    if msg.role != MessageRole.ASSISTANT:
                        continue
                    for block in msg.content:
                        if block.type == ContentBlockType.TEXT and block.text:
                            response_text += block.text

                return self.parser.parse_triage_result(
                    issue, response_text, self.config.repo
                )

        except Exception as e:
            print(f"Triage error for #{issue['number']}: {e}")
            return TriageResult(
                issue_number=issue["number"],
                repo=self.config.repo,
                category=TriageCategory.FEATURE,
                confidence=0.0,
            )

    def build_triage_context(
        self,
        issue: dict,
        all_issues: list[dict],
        potential_dupes: list[dict] | None = None,
    ) -> str:
        """Build context for triage including potential duplicates.

        Without `potential_dupes`, they are the issues whose titles share
        words with this one (`duplicate_candidates`).
        """
        if potential_dupes is None:
            from .duplicate_candidates import _shared_words

            potential_dupes = _shared_words(
                issue, [o for o in all_issues if o["number"] != issue["number"]]
            )

        # Issue text is quoted with the shared helpers (rule S2).
        from runners.forge_review_prompt import one_line
        from security.untrusted import quote_untrusted

        source = f"github:issue#{issue['number']}"

        def quoted(text: str, kind: str) -> str:
            return quote_untrusted(
                text, kind=kind, source=source, spec_dir=self.github_dir
            )

        labels = ", ".join(label["name"] for label in issue.get("labels", []))
        details = "\n".join(
            [
                f"Title: {one_line(issue['title'], 'comment', source, limit=500)}",
                f"Author: {one_line(issue['author']['login'], 'comment', source)}",
                f"Created: {one_line(issue['createdAt'], 'comment', source)}",
                f"Labels: {one_line(labels, 'comment', source, limit=500)}",
            ]
        )
        lines = [
            f"## Issue #{int(issue['number'])}",
            "",
            "### Details",
            quoted(details, "comment"),
            "",
            "### Body",
            quoted(issue.get("body") or "No description", "issue_body"),
            "",
        ]

        if potential_dupes:

            def score(d: dict) -> str:
                value = d.get("similarity")
                if isinstance(value, int | float) and not isinstance(value, bool):
                    return f" (similarity {float(value):.2f})"
                return ""

            dupes = "\n".join(
                f"- #{int(d['number'])}{score(d)}: "
                f"{one_line(d['title'], 'comment', source)}"
                for d in potential_dupes[:5]
            )
            by_meaning = any("similarity" in d for d in potential_dupes)
            lines.append(
                "### Potential Duplicates (closest in meaning)"
                if by_meaning
                else "### Potential Duplicates (similar titles)"
            )
            lines.append(quoted(dupes, "comment"))
            lines.append("")

        return "\n".join(lines)
