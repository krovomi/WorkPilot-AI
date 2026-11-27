"""Claude Ship on a task's pull request, when the app says it is on.

Claude Ship (Claude Code Review, Claude Approvals, PR Steward) runs on
GitHub for a Claude organization on a Team or Enterprise plan. The app turns
this adapter on (``WORKPILOT_CLAUDE_SHIP=1``) when a signed-in Claude account
is on such a plan, or when the person forces it in Settings; off, nothing
here is read and the follow-through behaves as before.

On, three things change, all read from the PR and never from a model:

- **Claude Code Review** (check run of the Claude GitHub App): its count of
  Important findings (``bughunter-severity``) stands in for the cross-review
  when WorkPilot's own did not review this tree: none is an agreement, one or
  more a disagreement.
- **Claude Approvals** (check run): the stricter of the two wins. While it
  runs, WorkPilot waits; when it fails, WorkPilot does not merge. An
  ``(observe mode)`` result, like a neutral one, changes nothing.
- **PR Steward** (label ``claude-pr-steward-watching``): one steward per PR,
  so the follow-through stops its own fix rounds and only watches.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

ENV = "WORKPILOT_CLAUDE_SHIP"
CLAUDE_APP_ID = 1236702
APPROVALS_CHECK = "Claude Approvals"
CODE_REVIEW_CHECK = "Claude Code Review"
STEWARD_LABEL = "claude-pr-steward-watching"
OBSERVE_PREFIX = "(observe mode)"

_SEVERITY = re.compile(r"bughunter-severity:\s*(\{[^{}\n]{0,400}\})")
_PASSING = frozenset({"success", "neutral", "skipped"})


@dataclass(frozen=True)
class ShipFacts:
    approvals: str | None = None
    """pass, observe, pending or fail; None when Claude Approvals did not run."""
    code_review: str | None = None
    """agree or disagree once Claude Code Review finished; None otherwise."""
    important: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "approvals": self.approvals,
            "codeReview": self.code_review,
            "important": self.important,
        }


def active(env: dict[str, str] | None = None) -> bool:
    return (env if env is not None else os.environ).get(ENV, "").strip() == "1"


def steward_watching(labels: tuple[str, ...] | list[str]) -> bool:
    return STEWARD_LABEL in labels


def _claude_run(run: Any, name: str) -> bool:
    if not isinstance(run, dict) or run.get("name") != name:
        return False
    app = run.get("app") or {}
    return isinstance(app, dict) and app.get("id") == CLAUDE_APP_ID


def _newest(runs: list[Any], name: str) -> dict[str, Any] | None:
    mine = [r for r in runs if _claude_run(r, name)]
    if not mine:
        return None
    return max(mine, key=lambda r: str(r.get("started_at") or ""))


def _approvals(run: dict[str, Any] | None) -> str | None:
    if run is None:
        return None
    if run.get("status") != "completed":
        return "pending"
    title = str((run.get("output") or {}).get("title") or "")
    if title.startswith(OBSERVE_PREFIX):
        return "observe"
    return "pass" if run.get("conclusion") in _PASSING else "fail"


def _important(run: dict[str, Any]) -> int | None:
    output = run.get("output") or {}
    for field in ("text", "summary"):
        match = _SEVERITY.search(str(output.get(field) or ""))
        if not match:
            continue
        try:
            counts = json.loads(match.group(1))
        except ValueError:
            return None
        value = counts.get("normal") if isinstance(counts, dict) else None
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
        return None
    return None


def read_checks(runs: list[Any] | None) -> ShipFacts:
    """What Claude Ship said on the head commit, from its check runs."""
    runs = runs or []
    approvals = _approvals(_newest(runs, APPROVALS_CHECK))
    review = _newest(runs, CODE_REVIEW_CHECK)
    if review is None or review.get("status") != "completed":
        return ShipFacts(approvals=approvals)
    if review.get("conclusion") == "skipped":
        return ShipFacts(approvals=approvals)
    important = _important(review)
    if important is None:
        # A finished review whose count cannot be read agrees with nothing.
        return ShipFacts(approvals=approvals)
    return ShipFacts(
        approvals=approvals,
        code_review="agree" if important == 0 else "disagree",
        important=important,
    )


def hold(decision: dict[str, Any], facts: ShipFacts) -> dict[str, Any]:
    """The decision once Claude Approvals had its say: it can only hold a merge."""
    out = {**decision, "claudeShip": facts.to_dict()}
    if not out.get("merges") or facts.approvals not in ("pending", "fail"):
        return out
    code = (
        "claude_approvals_pending"
        if facts.approvals == "pending"
        else "claude_approvals_failed"
    )
    out["merges"] = False
    out["action"] = "wait" if facts.approvals == "pending" else "human"
    out["reasons"] = [
        {
            "code": code,
            "tier": out.get("tier", ""),
            "detail": f"{APPROVALS_CHECK}: {facts.approvals}",
            "files": [],
        },
        *(out.get("reasons") or []),
    ]
    return out


__all__ = [
    "APPROVALS_CHECK",
    "CLAUDE_APP_ID",
    "CODE_REVIEW_CHECK",
    "ENV",
    "STEWARD_LABEL",
    "ShipFacts",
    "active",
    "hold",
    "read_checks",
    "steward_watching",
]
