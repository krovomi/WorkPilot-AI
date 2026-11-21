"""Apply what the project's review feedback taught to a review's findings (#361).

The learning itself is `learning_loop.review_feedback`; this module maps its
decisions onto `PRReviewFinding` objects. It runs on the findings once the
review is done, whatever the provider and whatever the model made of the
prompt block, so a remark the project rejected stays downgraded or removed
on Claude, Codex, Copilot, Ollama and the rest alike.

It never raises: an unreadable dataset reads as empty
(`review_feedback.load_feedback`), and a review runs without its history
rather than not at all.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import TYPE_CHECKING, Any

from learning_loop import review_feedback

if TYPE_CHECKING:
    from collections.abc import Callable

    from runners.github.models import MergeVerdict, PRReviewFinding, PRReviewResult

    # The initial review's verdict rule on a set of findings
    # (`GitHubOrchestrator._generate_verdict`).
    VerdictRule = Callable[[list[PRReviewFinding]], tuple[MergeVerdict, str, list[str]]]

# Least to most severe, by value: the runners import `models` under two names.
_VERDICT_RANK = {
    "ready_to_merge": 0,
    "merge_with_changes": 1,
    "needs_revision": 2,
    "blocked": 3,
}


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
    rules = review_feedback.rules_by_signature(project_dir, threshold)
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
    block = review_feedback.prompt_block(project_dir)
    return f"\n\n---\n\n{block}" if block else ""


def _rank(verdict: Any) -> int:
    return _VERDICT_RANK.get(getattr(verdict, "value", verdict), 2)


def apply_to_followup(
    project_dir: str | Path,
    result: PRReviewResult,
    verdict_rule: VerdictRule,
    ci_status: dict | None = None,
    threshold: int | None = None,
) -> bool:
    """The learned suppressions on a follow-up review's findings; True if they changed any.

    A follow-up's verdict comes from its reviewer (the model, for the parallel
    one), so it is recomputed with the initial review's rule (``verdict_rule``)
    on the findings that remain. The new verdict replaces the reviewer's only
    when the suppressed findings were what made it severe: it is lower than
    what the same rule gives on the findings as reported, and lower than the
    reviewer's. A suppression never makes a verdict more severe, and pending
    CI still keeps a follow-up out of "ready".
    """
    if not result.success or not result.findings:
        return False
    severities = [finding.severity for finding in result.findings]
    as_reported = [
        dataclasses.replace(finding, severity=severity)
        for finding, severity in zip(result.findings, severities)
    ]
    kept, dropped = apply_learned_suppressions(project_dir, result.findings, threshold)
    kept_ids = {id(finding) for finding in kept}
    lowered = [
        finding
        for finding, severity in zip(result.findings, severities)
        if id(finding) in kept_ids and finding.severity != severity
    ]
    if not dropped and not lowered:
        return False

    dropped_ids = {item["id"] for item in dropped}
    result.findings = kept
    result.learned_suppressions = dropped
    result.unresolved_findings = [
        fid for fid in result.unresolved_findings if fid not in dropped_ids
    ]
    result.new_findings_since_last_review = [
        fid for fid in result.new_findings_since_last_review if fid not in dropped_ids
    ]

    before, _reasoning, _blockers = verdict_rule(as_reported)
    after, reasoning, blockers = verdict_rule(kept)
    if _rank(after) < _rank(before) and _rank(after) < _rank(result.verdict):
        from runners.github.models import (
            apply_ci_status_override,
            verdict_to_github_status,
        )

        ci = ci_status or {}
        pending = ci.get("pending", 0) or 0
        held = apply_ci_status_override(after, pending_count=pending)
        if _rank(held) > _rank(after):
            reasoning = f"Ready once CI passes: {pending} check(s) still pending."
        result.verdict = type(result.verdict)(held.value)
        result.verdict_reasoning = reasoning
        result.blockers = blockers
        result.overall_status = verdict_to_github_status(result.verdict)
        recomputed = True
    else:
        # The verdict stands; what it blocked on no longer does.
        titles = [f": {item['title']}" for item in dropped] + [
            f": {finding.title}" for finding in lowered
        ]
        result.blockers = [
            blocker
            for blocker in result.blockers
            if not any(title in blocker for title in titles)
        ]
        recomputed = False

    result.summary = (result.summary or "") + _followup_note(
        len(dropped), len(lowered), result, recomputed
    )
    return True


def _followup_note(
    dropped: int, lowered: int, result: PRReviewResult, recomputed: bool
) -> str:
    lines = [
        "",
        "",
        "### Learned from this project's feedback",
        f"{dropped} finding(s) hidden and {lowered} downgraded to low by what "
        "this project rejected in earlier reviews.",
    ]
    if recomputed:
        verdict = result.verdict.value.upper().replace("_", " ")
        lines.append(
            f"Verdict recomputed on the remaining findings: **{verdict}**: "
            f"{result.verdict_reasoning}"
        )
    return "\n".join(lines)
