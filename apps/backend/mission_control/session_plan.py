"""What a Mission Control session was set up with, and what it leaves behind.

A crew applied from auto-compose hands its plan to the session: the providers
in the person's order (where a rebalanced agent may go) and the budget the
crew was composed under. A session built by hand has no plan; its providers
are those of its agents, in the order they were added.

``session_entry`` is the session's line in the metrics ledger
(``metrics.py``): numbers and role names only.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .agent_slot import AgentSlot
from .model_pick import normalise_provider

MAX_PLAN_PROVIDERS = 8


@dataclass
class SessionPlan:
    providers: list[str] = field(default_factory=list)
    budget_usd: float | None = None
    budget_tokens: int | None = None
    auto_rebalance: bool = True

    def fallback_providers(self, slots: Iterable[AgentSlot]) -> list[str]:
        """The plan's providers; else those of the session's agents, in order."""
        if self.providers:
            return list(self.providers)
        order: list[str] = []
        for slot in slots:
            name = normalise_provider(slot.provider)
            if name and name not in order:
                order.append(name)
        return order

    def over_budget(self, tokens: int, cost_usd: float) -> bool:
        if self.budget_usd is not None and cost_usd >= self.budget_usd:
            return True
        return self.budget_tokens is not None and tokens >= self.budget_tokens

    def to_dict(self) -> dict[str, Any]:
        return {
            "providers": list(self.providers),
            "budget_usd": self.budget_usd,
            "budget_tokens": self.budget_tokens,
            "auto_rebalance": self.auto_rebalance,
        }


def session_entry(
    slots: list[AgentSlot], plan: SessionPlan, rebalances: int
) -> dict[str, Any] | None:
    """The session's metrics line; None when no agent spent a token."""
    if not any(s.tokens.total_tokens for s in slots):
        return None
    origins = {s.origin for s in slots}
    origin = "mixed" if len(origins) > 1 else origins.pop()
    tokens = sum(s.tokens.total_tokens for s in slots)
    cost = sum(s.tokens.estimated_cost_usd for s in slots)
    auto = [s for s in slots if s.origin == "auto"]
    return {
        "origin": origin,
        "agents": len(slots),
        "estimated_tokens": sum(s.estimated_tokens for s in auto),
        "actual_tokens": tokens,
        "cost_usd": round(cost, 6),
        "budget_usd": plan.budget_usd,
        "budget_tokens": plan.budget_tokens,
        "over_budget": plan.over_budget(tokens, cost),
        "rebalances": rebalances,
        "roles": [
            {
                "role": s.role.value,
                "estimated": s.estimated_tokens,
                "actual": s.tokens.total_tokens,
            }
            for s in auto
            if s.estimated_tokens and s.tokens.total_tokens
        ],
    }


__all__ = ["MAX_PLAN_PROVIDERS", "SessionPlan", "session_entry"]
