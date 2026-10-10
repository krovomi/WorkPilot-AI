"""The PR-review specialists, moved out of the runners that declared them.

`runners/github/services/parallel_orchestrator_reviewer.py` built six
`AgentDefinition`s inline, and `parallel_followup_reviewer.py` four more — one
of them a second `finding-validator` with its own description. A roster the
registry does not know about cannot be specialised by language, cannot be
emitted to a harness directory, and cannot be capped alongside the rest.

Every specialist is declared once, in `PR_SPECIALISTS`, and each review names
the ones it carries in `PR_ROSTERS` — the same "definitions by name, rosters
as lists of names" shape `phases.py` uses.

Two things distinguish this roster from the phase defaults in `phases.py` and
shape the interface below.

**The prompts live in files.** Each specialist's real system prompt is one of
`prompts/github/pr_*.md`, which is where a prompt belongs — reviewers edit
those without touching Python. What is here is the *description* (when the
orchestrator should reach for this agent, which is the part the SDK matches
against) and the fallback used when a prompt file is missing.

**They run in a worktree.** A subagent does not inherit the parent's working
directory, so every prompt is prefixed with the path it should read from.
That prefix depends on the review, so the roster is a function of it rather
than a constant.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .phases import sdk_available

logger = logging.getLogger(__name__)

__all__ = [
    "PR_FOLLOWUP_SPECIALISTS",
    "PR_REVIEW_SPECIALISTS",
    "PR_ROSTERS",
    "PR_SPECIALISTS",
    "SpecialistSpec",
    "pr_review_agents",
]

# Read-only, deliberately. A reviewer that can edit the code it is reviewing
# stops being a reviewer.
_REVIEW_TOOLS = ["Read", "Grep", "Glob"]


@dataclass(frozen=True)
class SpecialistSpec:
    """One specialist, minus the parts that depend on the review being run."""

    name: str
    prompt_file: str
    description: str
    fallback: str
    tools: tuple[str, ...] = tuple(_REVIEW_TOOLS)


_SPECS: tuple[SpecialistSpec, ...] = (
    SpecialistSpec(
        name="security-reviewer",
        prompt_file="pr_security_agent.md",
        description=(
            "Security specialist. Use for OWASP Top 10, authentication, "
            "injection, cryptographic issues, and sensitive data exposure. "
            "Invoke when PR touches auth, API endpoints, user input, database queries, "
            "or file operations. Use Read, Grep, and Glob tools to explore related files, "
            "callers, and tests as needed."
        ),
        fallback="You are a security expert. Find vulnerabilities.",
    ),
    SpecialistSpec(
        name="quality-reviewer",
        prompt_file="pr_quality_agent.md",
        description=(
            "Code quality expert. Use for complexity, duplication, error handling, "
            "maintainability, and pattern adherence. Invoke when PR has complex logic, "
            "large functions, or significant business logic changes. Use Grep to search "
            "for similar patterns across the codebase for consistency checks."
        ),
        fallback="You are a code quality expert. Find quality issues.",
    ),
    SpecialistSpec(
        name="logic-reviewer",
        prompt_file="pr_logic_agent.md",
        description=(
            "Logic and correctness specialist. Use for algorithm verification, "
            "edge cases, state management, and race conditions. Invoke when PR has "
            "algorithmic changes, data transformations, concurrent operations, or bug fixes. "
            "Use Grep to find callers and dependents that may be affected by logic changes."
        ),
        fallback="You are a logic expert. Find correctness issues.",
    ),
    SpecialistSpec(
        name="codebase-fit-reviewer",
        prompt_file="pr_codebase_fit_agent.md",
        description=(
            "Codebase consistency expert. Use for naming conventions, ecosystem fit, "
            "architectural alignment, and avoiding reinvention. Invoke when PR introduces "
            "new patterns, large additions, or code that might duplicate existing functionality. "
            "Use Grep and Glob to explore existing patterns and conventions in the codebase."
        ),
        fallback="You are a codebase expert. Check for consistency.",
    ),
    SpecialistSpec(
        name="ai-triage-reviewer",
        prompt_file="pr_ai_triage.md",
        description=(
            "AI comment validator. Use for triaging comments from CodeRabbit, "
            "Gemini Code Assist, Cursor, Greptile, and other AI reviewers. "
            "Invoke when PR has existing AI review comments that need validation."
        ),
        fallback="You are an AI triage expert. Validate AI comments.",
    ),
    # Shared by both reviews. The follow-up declared its own copy, worded for
    # "unresolved" findings; one description now covers both inputs.
    SpecialistSpec(
        name="finding-validator",
        prompt_file="pr_finding_validator.md",
        description=(
            "Finding validation specialist. Re-investigates findings — new ones "
            "from the other specialists, or previous ones still marked unresolved "
            "— to validate they are actually real issues, not false positives. "
            "Reads the ACTUAL CODE at the finding location with fresh eyes. "
            "CRITICAL: Invoke for ALL such findings once the specialist agents "
            "(or resolution-verifier) have reported. "
            "Can confirm findings as valid OR dismiss them as false positives. "
            "Use Read, Grep, and Glob to check for mitigations the original agent missed."
        ),
        fallback="You validate whether findings are real issues.",
    ),
    # The follow-up review's own three, declared inline in
    # `parallel_followup_reviewer.py` until lot L11.
    SpecialistSpec(
        name="resolution-verifier",
        prompt_file="pr_followup_resolution_agent.md",
        description=(
            "Resolution verification specialist. Use to verify whether previous "
            "findings have been addressed. Analyzes diffs to determine if issues "
            "are truly fixed, partially fixed, or still unresolved. "
            "Invoke when: There are previous findings to verify."
        ),
        fallback="You verify whether previous findings are resolved.",
    ),
    SpecialistSpec(
        name="new-code-reviewer",
        prompt_file="pr_followup_newcode_agent.md",
        description=(
            "New code analysis specialist. Reviews code added since last review "
            "for security, logic, quality issues, and regressions. "
            "Invoke when: There are substantial code changes (>50 lines diff) or "
            "changes to security-sensitive areas."
        ),
        fallback="You review new code for issues.",
    ),
    SpecialistSpec(
        name="comment-analyzer",
        prompt_file="pr_followup_comment_agent.md",
        description=(
            "Comment and feedback analyst. Processes contributor comments and "
            "AI tool reviews (CodeRabbit, Cursor, Gemini, etc.) to identify "
            "unanswered questions and valid concerns. "
            "Invoke when: There are comments or formal reviews since last review."
        ),
        fallback="You analyze comments and feedback.",
    ),
)

#: Every PR specialist, by name. Declared once whatever the number of reviews
#: that carry it.
PR_SPECIALISTS: dict[str, SpecialistSpec] = {spec.name: spec for spec in _SPECS}

#: Which specialists each review carries, by name.
PR_ROSTERS: dict[str, tuple[str, ...]] = {
    "pr-review": (
        "security-reviewer",
        "quality-reviewer",
        "logic-reviewer",
        "codebase-fit-reviewer",
        "ai-triage-reviewer",
        "finding-validator",
    ),
    "pr-followup": (
        "resolution-verifier",
        "new-code-reviewer",
        "comment-analyzer",
        "finding-validator",
    ),
}

PR_REVIEW_SPECIALISTS: tuple[SpecialistSpec, ...] = tuple(
    PR_SPECIALISTS[name] for name in PR_ROSTERS["pr-review"]
)
PR_FOLLOWUP_SPECIALISTS: tuple[SpecialistSpec, ...] = tuple(
    PR_SPECIALISTS[name] for name in PR_ROSTERS["pr-followup"]
)


def pr_review_agents(
    load_prompt: Callable[[str], str | None],
    with_working_dir: Callable[[str | None, str], str],
    roster: str = "pr-review",
) -> dict[str, Any]:
    """Build the roster for one review — ``roster`` names a `PR_ROSTERS` entry.

    ``load_prompt`` reads a file from `prompts/github/`; ``with_working_dir``
    prefixes a prompt with the worktree the review is running in. Both are
    passed in rather than imported so this module stays free of the runner's
    path conventions and can be exercised without one.

    Empty when the SDK is absent, matching `phases.phase_defaults`.
    """
    if not sdk_available():
        return {}

    from claude_agent_sdk import AgentDefinition

    return {
        spec.name: AgentDefinition(
            description=spec.description,
            prompt=with_working_dir(load_prompt(spec.prompt_file), spec.fallback),
            tools=list(spec.tools),
            model="inherit",
        )
        for spec in (PR_SPECIALISTS[name] for name in PR_ROSTERS[roster])
    }
