"""What a CI/CD incident learns from the bisect, and what the fixer reads of it (#375)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from security.untrusted import quote_untrusted

from ..incident_responder.models import Incident
from .bisect import BisectResult

__all__ = ["apply_bisect", "render_first_bad"]


def apply_bisect(
    incident: Incident, result: BisectResult, read_diff: Callable[[str], str]
) -> None:
    """Record ``result`` on ``incident``; a found commit becomes the regression.

    The fixer then reads the diff of the first bad commit, not of the commit
    that happened to run the CI.
    """
    data = incident.source_data
    data["bisect"] = result.to_dict()
    if result.first_bad:  # only a found culprit has one
        incident.regression_commit = result.first_bad
        data.setdefault("head_diff_summary", data.get("diff_summary", ""))
        data["diff_summary"] = read_diff(result.first_bad)


def render_first_bad(data: dict[str, Any]) -> str:
    """The prompt's "first bad commit" section."""
    bisect = data.get("bisect") or {}
    status = bisect.get("status")
    if status == "found":
        sha = str(bisect.get("first_bad", ""))
        subject = quote_untrusted(
            str(bisect.get("first_bad_subject", "")),
            kind="comment",
            source="git history",
        )
        return (
            f"A bisect between the last green commit `{str(bisect.get('good', ''))[:12]}` "
            f"and the failing one ran the failing tests on {bisect.get('tested', 0)} "
            f"checkout(s): the first commit where they fail is `{sha}`. The DIFF "
            "below is that commit's, not the last commit's. Its subject, quoted "
            f"as repository text:\n{subject}"
        )
    if status in ("ambiguous", "budget"):
        candidates = ", ".join(f"`{c[:12]}`" for c in bisect.get("candidates", [])[:10])
        return (
            "A bisect narrowed the regression to one of these commits but not to "
            f"a single one: {candidates}. Read their diffs before the last commit's."
        )
    if status == "flaky":
        return (
            "A bisect found the failing test flaky: it passed on a rerun of the "
            "failing commit. Look for timing, ordering or shared state before "
            "changing the code under test."
        )
    if status:
        reason = str(bisect.get("reason", ""))[:200]
        return f"No first bad commit: the bisect ended `{status}` ({reason})."
    triggers = data.get("bisect_triggers") or {}
    if triggers.get("fired"):
        return (
            "The last commit is probably not the culprit "
            f"({', '.join(triggers.get('reasons', []))}), but no bisect ran: no "
            "green commit is known for this branch."
        )
    return "No bisect ran: the last commit is the first suspect."
