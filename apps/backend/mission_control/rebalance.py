"""Live rebalancing: what Mission Control does when an agent's run goes wrong.

A run ends in one of three ways worth acting on, each with its own remedy:

* **its provider failed** (a rate limit, a quota, a refused credential, an
  unreachable or unknown model): the same work goes to the next provider of
  the session that has a capable model of the same tier. A Claude rate limit
  first tries again on the same provider when the Claude profile system has
  another profile to run it on (``retry_profile``);
* **the agent failed** (an error that is not its provider's): its model goes
  one tier up on the same provider, ``fast`` → ``standard`` → ``flagship``;
* **the agent loops**: its answer repeats the same passage over and over
  (``detect_loop``); the run is stopped and its model goes one tier up.

When no higher tier exists, the work goes to another provider at the same
tier. Nothing is decided from the error text beyond the closed list of
``foundation.error_details.classify``; the text itself is never acted on.

An agent is rebalanced at most ``MAX_REBALANCES`` times for one task, never
when the session is over its budget (a bigger model costs more), and never
when the person turned automatic rebalancing off. Every decision, taken or
not, is logged for the dashboard (``orchestrator.rebalance_agent``).
"""

from __future__ import annotations

from dataclasses import dataclass

from foundation import error_details as codes
from models_registry import list_provider

from .agent_slot import ROLE_MODEL_RECOMMENDATIONS, AgentRole
from .composition import BASE_CONTEXT, ROLE_PROFILES
from .model_pick import ModelPick, is_local, normalise_provider, pick, runs_agents

MAX_REBALANCES = 2

# One tier up; a local or CLI-chosen model has no tier above it.
NEXT_TIER: dict[str, str] = {"fast": "standard", "standard": "flagship"}
REGISTRY_TIERS = frozenset({"fast", "standard", "flagship"})

PROVIDER_FAILURES = frozenset(
    {
        codes.AUTH,
        codes.NETWORK,
        codes.PROVIDER_UNAVAILABLE,
        codes.MODEL_UNAVAILABLE,
    }
)
RATE_LIMITS = frozenset({codes.RATE_LIMIT, codes.QUOTA})

# The loop detector: a passage of LOOP_MIN to LOOP_MAX characters repeated
# LOOP_REPEATS times in a row at the end of the answer. A passage made of
# fewer than LOOP_DISTINCT characters (a ruler of dashes) is layout, not a loop.
LOOP_MIN = 30
LOOP_MAX = 600
LOOP_REPEATS = 5
LOOP_DISTINCT = 5


def detect_loop(text: str) -> bool:
    """True when the end of ``text`` is one passage repeated, whatever its cut."""
    for size in range(LOOP_MIN, LOOP_MAX + 1):
        span = size * LOOP_REPEATS
        if span > len(text):
            return False
        window = text[-span:]
        # A window that equals itself shifted by ``size`` has that period,
        # whether the last chunk ended mid-passage or not.
        if window[:-size] == window[size:] and len(set(window[:size])) >= (
            LOOP_DISTINCT
        ):
            return True
    return False


def reason_of(error: str, *, rate_limited: bool, loop: bool) -> str:
    """``loop``, ``rate_limited``, ``provider_failed`` or ``failed``."""
    if loop:
        return "loop"
    code = codes.classify(error)
    if rate_limited or code in RATE_LIMITS:
        return "rate_limited"
    if code in PROVIDER_FAILURES:
        return "provider_failed"
    return "failed"


def tier_of(provider: str, model: str, role: str) -> str:
    """The registry's tier of ``model``; the role's usual tier when unknown."""
    if is_local(provider):
        return "local"
    for entry in list_provider(provider):
        if entry.model_id == model:
            return entry.tier
    try:
        return ROLE_MODEL_RECOMMENDATIONS[AgentRole(role)]
    except ValueError:
        return "standard"


def capable(model: ModelPick, role: str) -> bool:
    """The model can do the role: tool use when the role needs it, a usable window."""
    needs_tools = ROLE_PROFILES.get(role, (0.0, 0, False))[2]
    if needs_tools and model.tool_use is False:
        return False
    return model.context_window >= BASE_CONTEXT


@dataclass(frozen=True)
class Rebalance:
    """What to do with a run that went wrong; ``action`` ``none`` says why not."""

    action: str
    reason: str
    provider: str = ""
    model: str = ""
    model_label: str = ""
    skipped: str = ""

    def to_dict(self) -> dict[str, str]:
        return {
            "action": self.action,
            "reason": self.reason,
            "provider": self.provider,
            "model": self.model,
            "model_label": self.model_label,
            "skipped": self.skipped,
        }


def _move(action: str, reason: str, model: ModelPick) -> Rebalance:
    return Rebalance(action, reason, model.provider, model.model, model.label)


def _reroute(
    reason: str,
    role: str,
    tier: str,
    current: str,
    providers: list[str],
    tried: set[str],
) -> Rebalance | None:
    for raw in providers:
        name = normalise_provider(raw)
        if name == current or name in tried or not runs_agents(name):
            continue
        # A local or CLI-chosen model has no tier elsewhere: standard work.
        model = pick(name, tier if tier in REGISTRY_TIERS else "standard")
        if capable(model, role):
            return _move("reroute", reason, model)
    return None


def _escalate(
    reason: str, role: str, tier: str, provider: str, model: str
) -> Rebalance | None:
    above = NEXT_TIER.get(tier)
    if above is None:
        return None
    upper = pick(provider, above)
    if upper.model == model or not capable(upper, role):
        return None
    return _move("escalate", reason, upper)


def plan_rebalance(
    *,
    role: str,
    provider: str,
    model: str,
    reason: str,
    providers: list[str],
    tried: set[str],
    count: int,
    over_budget: bool,
    alternate_profile: bool,
) -> Rebalance:
    """The remedy for a run that ended for ``reason`` (``reason_of``)."""
    if count >= MAX_REBALANCES:
        return Rebalance("none", reason, skipped="limit")
    if over_budget:
        return Rebalance("none", reason, skipped="over_budget")
    current = normalise_provider(provider)
    tier = tier_of(current, model, role)
    if reason == "rate_limited" and current == "anthropic" and alternate_profile:
        return Rebalance("retry_profile", reason, current, model, model)
    if reason in ("rate_limited", "provider_failed"):
        found = _reroute(reason, role, tier, current, providers, tried)
    else:
        found = _escalate(reason, role, tier, current, model) or _reroute(
            reason, role, tier, current, providers, tried
        )
    return found or Rebalance("none", reason, skipped="no_alternative")


__all__ = [
    "MAX_REBALANCES",
    "Rebalance",
    "capable",
    "detect_loop",
    "plan_rebalance",
    "reason_of",
    "tier_of",
]
