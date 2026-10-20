"""Context-window management for agent sessions: measure, compact, clear.

See ``docs/architecture/context-management.md``. Entry point for the
session runner: ``ContextGuard``; for the client factories:
``native_auto_compact_env`` / ``codex_auto_compact_limit``.
"""

from .decide import Decision, Situation, decide, recommended_action
from .guard import ContextGuard
from .policy import ContextPolicy, load_context_policy, policy_from_dict
from .reset_limit import MAX_CONSECUTIVE_RESETS, ResetLimit
from .windows import effective_window, resolve_context_window


def native_auto_compact_env(spec_dir, model: str | None = None) -> dict[str, str]:
    """Env vars that make the Claude CLI auto-compact at the task's threshold.

    The CLI reads the percentage against the model's whole window; where the
    model bills a longer prompt at a higher rate, the percentage is scaled so
    that it lands at the task's threshold of the payable window instead
    (`effective_window`). Empty when the policy is off or asks for clears
    only: the CLI keeps its own default then, and WorkPilot's guard decides
    alone.
    """
    try:
        policy = load_context_policy(spec_dir) if spec_dir else None
    except Exception:  # noqa: BLE001
        return {}
    if policy is None or policy.mode not in ("auto", "compact"):
        return {}
    window = resolve_context_window(model)
    pct = policy.threshold_pct * effective_window(model, window) / window
    return {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(max(1, int(pct)))}


def codex_auto_compact_limit(
    spec_dir, window_tokens: int, model: str | None = None
) -> int | None:
    """``model_auto_compact_token_limit`` for Codex, or None to keep its default.

    A share of the payable window (`effective_window`), not of the announced
    one.
    """
    try:
        policy = load_context_policy(spec_dir) if spec_dir else None
    except Exception:  # noqa: BLE001
        return None
    if policy is None or policy.mode not in ("auto", "compact") or window_tokens <= 0:
        return None
    return int(effective_window(model, window_tokens) * policy.threshold_pct / 100)


__all__ = [
    "MAX_CONSECUTIVE_RESETS",
    "ContextGuard",
    "ContextPolicy",
    "Decision",
    "ResetLimit",
    "Situation",
    "codex_auto_compact_limit",
    "decide",
    "load_context_policy",
    "native_auto_compact_env",
    "policy_from_dict",
    "recommended_action",
]
