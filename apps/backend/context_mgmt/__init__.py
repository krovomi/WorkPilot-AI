"""Context-window management for agent sessions: measure, compact, clear.

See ``docs/architecture/context-management.md``. Entry point for the
session runner: ``ContextGuard``; for the client factories:
``native_auto_compact_env`` / ``codex_auto_compact_limit``.
"""

from .decide import Decision, Situation, decide, recommended_action
from .guard import ContextGuard
from .policy import ContextPolicy, load_context_policy, policy_from_dict
from .resets import MAX_CONSECUTIVE_RESETS, ResetBudget, budget_spent_message


def native_auto_compact_env(spec_dir) -> dict[str, str]:
    """Env vars that make the Claude CLI auto-compact at the task's threshold.

    Empty when the policy is off or asks for clears only: the CLI keeps its own
    default then, and WorkPilot's guard decides alone.
    """
    try:
        policy = load_context_policy(spec_dir) if spec_dir else None
    except Exception:  # noqa: BLE001
        return {}
    if policy is None or policy.mode not in ("auto", "compact"):
        return {}
    return {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(policy.threshold_pct)}


def codex_auto_compact_limit(spec_dir, window_tokens: int) -> int | None:
    """``model_auto_compact_token_limit`` for Codex, or None to keep its default."""
    try:
        policy = load_context_policy(spec_dir) if spec_dir else None
    except Exception:  # noqa: BLE001
        return None
    if policy is None or policy.mode not in ("auto", "compact") or window_tokens <= 0:
        return None
    return int(window_tokens * policy.threshold_pct / 100)


__all__ = [
    "MAX_CONSECUTIVE_RESETS",
    "ContextGuard",
    "ContextPolicy",
    "Decision",
    "ResetBudget",
    "Situation",
    "budget_spent_message",
    "codex_auto_compact_limit",
    "decide",
    "load_context_policy",
    "native_auto_compact_env",
    "policy_from_dict",
    "recommended_action",
]
