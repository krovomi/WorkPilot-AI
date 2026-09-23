"""One evaluation per review context, before parallel reviewers are dispatched."""

from __future__ import annotations

import shlex

from .adapters import ReviewInput, assess_review
from .rubrics import advice_text


async def evaluate_context(worker, context, *, followup=False):
    run = worker.fork()
    changed = (
        getattr(context, "files_changed_since_review", [])
        if followup
        else context.changed_files
    )
    files = [
        item
        if isinstance(item, str)
        else item.get("new_path", item.get("path", item.get("old_path", "")))
        if isinstance(item, dict)
        else item.path
        for item in changed
    ]
    revision = (
        getattr(context, "current_commit_sha", "")
        if followup
        else (context.head_sha or "")
    )
    diff = getattr(context, "diff_since_review", "") if followup else context.diff
    if (
        not followup
        and changed
        and all(isinstance(item, dict) and "diff" in item for item in changed)
    ):
        # GitLab patches carry paths separately; retain those boundaries for redaction.
        diff = "\n".join(
            f"diff --git {shlex.quote('a/' + str(item.get('old_path') or item.get('new_path') or 'unknown'))} "
            f"{shlex.quote('b/' + str(item.get('new_path') or item.get('old_path') or 'unknown'))}\n{item['diff']}"
            for item in changed
            if item.get("diff")
        )
    outcome = await assess_review(
        run,
        ReviewInput(
            getattr(context, "title", "Follow-up code review"),
            getattr(context, "description", ""),
            files,
            diff,
            revision or "unavailable",
            "followup" if followup else "review",
        ),
    )
    context.jev_outcome = outcome
    return run.observation


def context_advice(context) -> str:
    return advice_text(getattr(context, "jev_outcome", None))
