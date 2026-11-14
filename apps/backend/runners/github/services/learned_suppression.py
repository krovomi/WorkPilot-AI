"""Apply what the project's review feedback taught to a review's findings (#361).

The learning itself is `learning_loop.review_feedback`; this module maps its
decisions onto `PRReviewFinding` objects. It runs on the findings once the
review is done, whatever the provider and whatever the model made of the
prompt block, so a remark the project rejected stays downgraded or removed
on Claude, Codex, Copilot, Ollama and the rest alike.

Never raises: a review that runs without its history is worse, a review that
crashes is useless.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from learning_loop import review_feedback

if TYPE_CHECKING:
    from runners.github.models import PRReviewFinding

logger = logging.getLogger(__name__)


def apply_learned_suppressions(
    project_dir: str | Path,
    findings: list[PRReviewFinding],
    threshold: int | None = None,
) -> tuple[list[PRReviewFinding], list[dict[str, Any]]]:
    """``(kept, dropped)``: kept findings, some downgraded; the dropped ones described.

    A downgraded finding becomes ``low`` and carries ``learned_rejections``,
    shown in the review; a dropped one is listed in the result's
    ``learned_suppressions`` so nothing disappears without a trace.
    """
    try:
        rules = review_feedback.rules_by_signature(project_dir, threshold)
    except (OSError, ValueError) as exc:
        logger.warning("learned suppressions skipped: %s", type(exc).__name__)
        return findings, []
    if not rules:
        return findings, []

    kept: list[PRReviewFinding] = []
    dropped: list[dict[str, Any]] = []
    for finding in findings:
        decision = review_feedback.decide(
            finding.category.value,
            finding.severity.value,
            finding.title,
            rules,
            threshold,
        )
        rule = decision.rule
        if decision.action == "drop" and rule is not None:
            dropped.append(
                {
                    "id": finding.id,
                    "title": finding.title,
                    "category": finding.category.value,
                    "severity": finding.severity.value,
                    "file": finding.file,
                    "line": finding.line,
                    "signature": rule.signature,
                    "rejections": rule.rejections,
                }
            )
            continue
        if decision.action == "downgrade" and rule is not None:
            # The finding's own enum class: the runners import `models` under
            # two names depending on how they were started.
            finding.severity = type(finding.severity)("low")
            finding.learned_rejections = rule.rejections
        kept.append(finding)
    return kept, dropped


def learned_prompt_block(project_dir: str | Path) -> str:
    """The prompt section for the reviewers, framed like the other context blocks."""
    try:
        block = review_feedback.prompt_block(project_dir)
    except (OSError, ValueError) as exc:
        logger.warning("learned prompt block skipped: %s", type(exc).__name__)
        return ""
    return f"\n\n---\n\n{block}" if block else ""
