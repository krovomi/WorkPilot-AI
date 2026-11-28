"""The hours and the token budgets of ``workpilot.policy.yaml``, on every session.

``security.governance_policy`` reads them; this module applies them where every
provider's session goes through (``agents.session``, by ``SessionGuards``):
the Claude SDK, the CLI agents and WorkPilot's own loop alike. The write and
command hook refuses an action outside the hours where a hook exists (the SDK,
``ToolExecutor``); this watch is what stops the agents that have none, and what
turns a refusal into a pause the card explains.

- **Hours**: outside the allowed windows, the session stops at the next tool
  call (the action under way finishes) and the task is paused, reason
  ``policy_hours``.
- **Budget**: the tokens every session of the project spent in the last 60
  minutes, read from the usage ledger every provider writes
  (``cost_budget.spend``; input plus output, cache reads aside). At or past
  ``budget.max_tokens_per_hour`` the task is paused, reason ``policy_budget``.
  ``budget.max_tokens_per_task`` does the same with every session of the task
  itself, whenever they ran. The ledger records a session when it ends, so a
  session under way finishes its current step before it is counted: the
  check is a ceiling between steps, not a meter inside one model call.
- **An invalid policy**: no agent starts, the task is paused, reason
  ``policy_invalid``, and the errors are printed in its log. The write and
  command hook refuses everything as well; the pause spares the prompt and
  tells the card why.

The checks run when the session starts and at each tool call; the coder and
QA loops also ask before a session starts (``policy_pause_before_session``), so
a task outside its hours does not even send its prompt. Each pause is written
to the policy's audit trail.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from cost_budget.spend import project_root, usages
from foundation.pause_state import pause_task
from security import policy_audit
from security.governance_policy import Governance, schedule_refusal
from security.guardrail_policy import Policy, load_policy

logger = logging.getLogger(__name__)

HOURS_REASON = "policy_hours"
BUDGET_REASON = "policy_budget"
INVALID_REASON = "policy_invalid"
#: How many of the policy's errors the task's log lists.
_ERRORS_SHOWN = 5
_PAUSE_PHASE = {"planning": "planning", "coding": "coding", "validation": "qa_review"}


def tokens_last_hour(project: Path, now: datetime | None = None) -> int:
    """Tokens every session of ``project`` spent in the 60 minutes before ``now``."""
    since = (now or datetime.now(UTC)) - timedelta(hours=1)
    return sum(u.tokens for u in usages(project) if u.at is not None and u.at >= since)


def tokens_of_task(project: Path, task: str) -> int:
    """Tokens every session of the task ``task`` of ``project`` spent, all along."""
    return sum(u.tokens for u in usages(project) if u.spec_id == task)


def _identity(client: Any) -> tuple[str | None, str | None]:
    """The provider and model of a session's client, as far as it says."""
    if client is None:
        return None, None
    provider = None
    namer = getattr(client, "provider_name", None)
    if callable(namer):
        try:
            provider = str(namer())
        except (TypeError, ValueError, AttributeError):
            provider = None
    model = getattr(client, "model", None)
    if not isinstance(model, str):
        model = getattr(getattr(client, "options", None), "model", None)
        provider = provider or ("claude" if model else None)
    return provider, model if isinstance(model, str) and model else None


def verdict(
    project: Path,
    governance: Governance | None,
    now: datetime | None = None,
    task: str | None = None,
) -> tuple[str, str, dict[str, Any]] | None:
    """(reason, message, detail) when agents must stop now; ``None`` otherwise."""
    if governance is None:
        return None
    if closed := schedule_refusal(governance, now):
        return (
            HOURS_REASON,
            closed,
            {
                "timezone": governance.timezone,
                "allowedHours": [w.label() for w in governance.windows],
            },
        )
    limit = governance.max_tokens_per_hour
    if limit:
        spent = tokens_last_hour(project, now)
        if spent >= limit:
            return (
                BUDGET_REASON,
                f"The project's agents spent {spent:,} tokens in the last hour, at or "
                f"past the {limit:,} workpilot.policy.yaml allows. The task is paused; "
                "resume it once the hour has passed.",
                {"tokensLastHour": spent, "maxTokensPerHour": limit},
            )
    task_limit = governance.max_tokens_per_task
    if task_limit and task:
        spent = tokens_of_task(project, task)
        if spent >= task_limit:
            return (
                BUDGET_REASON,
                f"This task's agents spent {spent:,} tokens, at or past the "
                f"{task_limit:,} per task workpilot.policy.yaml allows. The task is "
                "paused; raise the limit in the policy, or finish it by hand.",
                {"tokensThisTask": spent, "maxTokensPerTask": task_limit},
            )
    return None


def stop_verdict(
    project: Path, policy: Policy, task: str | None = None, now: datetime | None = None
) -> tuple[str, str, dict[str, Any]] | None:
    """:func:`verdict`, after the policy itself: an invalid one stops every agent."""
    if policy.errors:
        shown = "; ".join(e[:200] for e in policy.errors[:_ERRORS_SHOWN])
        more = len(policy.errors) - _ERRORS_SHOWN
        return (
            INVALID_REASON,
            f"The guardrails policy is invalid ({len(policy.errors)} error(s)): {shown}"
            + (f"; and {more} more" if more > 0 else "")
            + ". No agent runs until it is fixed (Settings > Guardrails lists every "
            "error); then resume the task.",
            {"errorCount": len(policy.errors)},
        )
    return verdict(project, policy.governance, now, task=task)


class PolicyWatch:
    """Pauses a session's task when the policy says agents must stop."""

    def __init__(self, spec_dir: Path, phase: str, client: Any = None) -> None:
        self.spec_dir = Path(spec_dir)
        self.phase = _PAUSE_PHASE.get(str(phase), str(phase))
        self.project = project_root(self.spec_dir)
        self.provider, self.model = _identity(client)
        self.tripped = False
        self.check()

    def check(self, now: datetime | None = None) -> bool:
        """True once, when this check pauses the task."""
        if self.tripped or self.project is None:
            return False
        found = stop_verdict(
            self.project, load_policy(self.project), self.spec_dir.name, now
        )
        if found is None:
            return False
        self.tripped = True
        pause(
            self.spec_dir,
            self.phase,
            found,
            provider=self.provider,
            model=self.model,
            project=self.project,
        )
        return True

    def call(self, name: str, arguments: Any, call_id: str | None = None) -> None:
        self.check()


_AUDIT: dict[str, tuple[str, list[str]]] = {
    HOURS_REASON: ("outside_hours", ["schedule.allowed_hours"]),
    INVALID_REASON: ("invalid_policy", []),
}


def pause(
    spec_dir: Path,
    phase: str,
    found: tuple[str, str, dict[str, Any]],
    *,
    project: Path,
    provider: str | None = None,
    model: str | None = None,
) -> None:
    reason, message, detail = found
    logger.warning("Policy: %s", message)
    print(f"\n[Policy] {message}", flush=True)
    pause_task(
        spec_dir,
        phase=_PAUSE_PHASE.get(phase, phase),
        reason=reason,
        detail={"policy": {"reason": reason, **detail}},
    )
    decision, rules = _AUDIT.get(reason, ("budget_exceeded", []))
    if reason == BUDGET_REASON:
        rules = [
            "budget.max_tokens_per_task"
            if "maxTokensPerTask" in detail
            else "budget.max_tokens_per_hour"
        ]
    policy_audit.record(
        project,
        decision=decision,
        rules=rules,
        reason=message,
        task=Path(spec_dir).name,
        provider=provider,
        model=model,
    )


def policy_pause_before_session(spec_dir: Path, phase: str) -> str | None:
    """Pause the task before its next session if the policy says so; the reason."""
    project = project_root(Path(spec_dir))
    if project is None:
        return None
    found = stop_verdict(project, load_policy(project), Path(spec_dir).name)
    if found is None:
        return None
    pause(spec_dir, phase, found, project=project)
    return found[0]


__all__ = [
    "BUDGET_REASON",
    "HOURS_REASON",
    "INVALID_REASON",
    "PolicyWatch",
    "policy_pause_before_session",
    "stop_verdict",
    "tokens_last_hour",
    "tokens_of_task",
    "verdict",
]
