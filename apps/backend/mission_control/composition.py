"""Suggest a Mission Control crew, and a cheaper one when a budget asks for it.

From the signals of the work (``signals.py``), optionally refined by a light
model (``refine.py``), a template (``templates.py``) becomes a list of agents:
a role, a provider, a model and what it should cost. The steps:

1. **Template.** The one the person picked; else the one the model named;
   else the card's kind; else, for a description too vague to classify,
   ``generic`` with the ``vague_input`` warning.
2. **Crew.** The coders follow the size of the work (one, two, three); the
   tester comes when the project has a test suite, the text talks of tests or
   the work is large; a documentation task gets a documenter, work across three
   domains or more an architect.
3. **Models.** Each role goes to the first provider of the person's list that
   has a capable model of its tier (``model_pick``): tool use when the role
   reads and changes code, a context window that holds what one call reads.
   Providers mix: a role nobody's tier serves goes to the next provider.
4. **Budget.** With a ceiling in dollars or tokens, the crew is degraded step
   by step until it fits (``STEPS``): non-critical roles to the fast tier,
   one coder, optional roles dropped, critical flagships to standard, every
   role to the cheapest capable provider of the list. The first crew that fits
   is proposed, with the cost saved and the expected quality kept; when none
   does, the composition is refused and says how much the smallest crew needs.

Token counts are an order of magnitude, like ``cost_intelligence``'s own
predictor: the point is to compare crews, not to bill one.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from tasks.classify import TaskKind

from .model_pick import ModelPick, normalise_provider, pick, runs_agents
from .refine import Hints, refinement_request
from .signals import CompositionSignals
from .templates import GENERIC, TEMPLATES, RoleSlot, template_for_kind

# What one call of a role reads (``reads`` × the context) and writes, and
# whether it reads and changes code through tools.
ROLE_PROFILES: dict[str, tuple[float, int, bool]] = {
    "architect": (2.0, 4_000, True),
    "planner": (2.0, 3_000, False),
    "coder": (4.0, 8_000, True),
    "reviewer": (3.0, 2_500, True),
    "tester": (2.0, 5_000, True),
    "debugger": (4.0, 4_000, True),
    "documenter": (1.5, 3_000, False),
}
SIZE_FACTOR = {"small": 0.6, "medium": 1.0, "large": 1.8}
CODERS = {"small": 1, "medium": 2, "large": 3}
DEFAULT_FILES = {"small": 2, "medium": 6, "large": 15}
BASE_CONTEXT = 4_000
FILE_TOKENS = 1_500
# Expected quality of a tier, relative to a flagship; a critical role counts twice.
TIER_WEIGHT = {
    "flagship": 1.0,
    "standard": 0.8,
    "fast": 0.55,
    "local": 0.55,
    "provider_default": 0.8,
}

STEPS = (
    "non_critical_fast",
    "single_coder",
    "drop_optional",
    "critical_standard",
    "cheapest_provider",
)


class CompositionError(ValueError):
    """A composition that cannot be made, named by a code the UI translates."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class PlannedAgent:
    key: str
    slot: RoleSlot
    tier: str
    model: ModelPick
    input_tokens: int
    output_tokens: int
    context_need: int

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def cost(self) -> float | None:
        return self.model.cost(self.input_tokens, self.output_tokens)

    @property
    def weight(self) -> float:
        return TIER_WEIGHT[self.model.tier] * (2 if self.slot.critical else 1)

    def to_dict(self) -> dict[str, object]:
        cost = self.cost
        return {
            "key": self.key,
            "role": self.slot.role,
            "critical": self.slot.critical,
            "optional": self.slot.optional,
            "provider": self.model.provider,
            "model": self.model.model,
            "model_label": self.model.label,
            "tier": self.model.tier,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": None if cost is None else round(cost, 4),
            "flat_rate": self.model.flat_rate,
            "tool_use": self.model.tool_use,
            "context_window": self.model.context_window,
        }


@dataclass(frozen=True)
class _Plan:
    providers: tuple[str, ...]
    context: int
    files: int
    size: str


def _capable(model: ModelPick, slot: RoleSlot, need: int) -> bool:
    needs_tools = ROLE_PROFILES[slot.role][2]
    if needs_tools and model.tool_use is False:
        return False
    return model.context_window >= need


def _rank(agent: PlannedAgent) -> float:
    cost = agent.cost
    return float("inf") if cost is None else cost


def _choose(
    plan: _Plan, slot: RoleSlot, tier: str, base: PlannedAgent, cheapest: bool
) -> PlannedAgent | None:
    """``base`` moved to ``tier`` on the first (or cheapest) capable provider."""
    options = [
        replace(base, tier=tier, model=model)
        for model in (pick(p, tier) for p in plan.providers)
        if _capable(model, slot, base.context_need)
    ]
    if not options:
        return None
    return min(options, key=_rank) if cheapest else options[0]


def _agent(plan: _Plan, slot: RoleSlot, key: str, share: int) -> PlannedAgent | None:
    reads, output, _tools = ROLE_PROFILES[slot.role]
    files = max(1, plan.files // share)
    context = plan.context + files * FILE_TOKENS
    draft = PlannedAgent(
        key=key,
        slot=slot,
        tier=slot.tier,
        model=pick(plan.providers[0], slot.tier),
        input_tokens=int(context * reads * SIZE_FACTOR[plan.size]),
        output_tokens=int(output * SIZE_FACTOR[plan.size]),
        context_need=context,
    )
    return _choose(plan, slot, slot.tier, draft, cheapest=False)


def _roles(
    template_roles: tuple[RoleSlot, ...],
    size: str,
    domains: list[str],
    needs_tester: bool,
) -> list[tuple[RoleSlot, int]]:
    """The template's roles with their counts, adjusted to the work."""
    roles = [
        (slot, CODERS[size] if slot.scales else 1)
        for slot in template_roles
        if slot.role != "tester" or needs_tester
    ]
    present = {slot.role for slot, _ in roles}
    if "docs" in domains and "documenter" not in present:
        roles.append((RoleSlot("documenter", "fast", optional=True), 1))
    if len(domains) >= 3 and "architect" not in present:
        roles.insert(0, (RoleSlot("architect", "standard"), 1))
    return roles


def _summary(agents: list[PlannedAgent], full: list[PlannedAgent]) -> dict[str, object]:
    full_weight = sum(a.weight for a in full)
    return {
        "agents": [a.to_dict() for a in agents],
        "cost_usd": round(_cost(agents), 4),
        "tokens": _tokens(agents),
        "unpriced": sum(1 for a in agents if a.cost is None),
        "quality": round(sum(a.weight for a in agents) / full_weight, 2),
    }


def _step(plan: _Plan, step: str, agents: list[PlannedAgent]) -> list[PlannedAgent]:
    if step == "single_coder":
        first = next((a for a in agents if a.slot.scales), None)
        return [a for a in agents if not a.slot.scales or a is first]
    if step == "drop_optional":
        return [a for a in agents if not a.slot.optional]
    out: list[PlannedAgent] = []
    for agent in agents:
        tier = agent.tier
        if step == "non_critical_fast" and not agent.slot.critical:
            tier = "fast"
        elif step == "critical_standard" and tier == "flagship":
            tier = "standard"
        elif step != "cheapest_provider":
            out.append(agent)
            continue
        out.append(_choose(plan, agent.slot, tier, agent, cheapest=True) or agent)
    return out


def _cost(agents: list[PlannedAgent]) -> float:
    """What the priced agents cost; an unpriced one is warned about, not guessed."""
    return sum(a.cost or 0.0 for a in agents)


def _tokens(agents: list[PlannedAgent]) -> int:
    return sum(a.tokens for a in agents)


def _fits(agents: list[PlannedAgent], usd: float | None, tokens: int | None) -> bool:
    if usd is not None and _cost(agents) > usd:
        return False
    return tokens is None or _tokens(agents) <= tokens


def _changes(full: list[PlannedAgent], proposed: list[PlannedAgent]) -> list[dict]:
    after = {a.key: a for a in proposed}
    changes: list[dict] = []
    for agent in full:
        now = after.get(agent.key)
        if now is None:
            changes.append(
                {"key": agent.key, "role": agent.slot.role, "kind": "dropped"}
            )
        elif now.model != agent.model:
            changes.append(
                {
                    "key": agent.key,
                    "role": agent.slot.role,
                    "kind": "model",
                    "from": agent.to_dict(),
                    "to": now.to_dict(),
                }
            )
    return changes


def _template(
    template_key: str | None, hints: Hints | None, signals: CompositionSignals
) -> tuple[str, str]:
    if template_key:
        return template_key, "chosen"
    if hints and hints.kind:
        return hints.kind, "model"
    if signals.vague:
        return GENERIC.key, "fallback"
    return template_for_kind(TaskKind(signals.kind)).key, "kind"


def suggest_composition(
    signals: CompositionSignals,
    providers: list[str],
    *,
    template_key: str | None = None,
    budget_usd: float | None = None,
    budget_tokens: int | None = None,
    hints: Hints | None = None,
    hints_unusable: bool = False,
    refine_text: str | None = None,
) -> dict[str, object]:
    """The crew for this work on these providers, within this budget.

    ``refine_text``: the description a light model of the first provider is
    asked about; the request comes back as ``refinement`` (``refine.py``).
    """
    warnings: list[dict[str, object]] = []
    usable: list[str] = []
    for raw in providers:
        name = normalise_provider(raw)
        if name in usable:
            continue
        if runs_agents(name):
            usable.append(name)
        else:
            warnings.append(
                {"code": "provider_unsupported", "params": {"provider": name}}
            )
    if not usable:
        raise CompositionError("no_provider")

    key, source = _template(template_key, hints, signals)
    if source == "fallback":
        warnings.append({"code": "vague_input", "params": {}})
    if hints_unusable:
        warnings.append({"code": "hints_unusable", "params": {}})
    size = (hints.complexity if hints else None) or signals.complexity
    domains = sorted(set(signals.domains) | set(hints.domains if hints else ()))
    needs_tester = (
        signals.has_test_suite
        or signals.mentions_tests
        or size == "large"
        or bool(hints and hints.needs_tests)
    )

    plan = _Plan(
        providers=tuple(usable),
        context=BASE_CONTEXT + signals.spec_tokens,
        files=signals.touched_files or DEFAULT_FILES[size],
        size=size,
    )
    full: list[PlannedAgent] = []
    for slot, count in _roles(TEMPLATES[key].roles, size, domains, needs_tester):
        for index in range(count):
            agent = _agent(plan, slot, f"{slot.role}-{index + 1}", count)
            if agent is None:
                warnings.append(
                    {"code": "role_unserved", "params": {"role": slot.role}}
                )
                break
            full.append(agent)
    if not full:
        raise CompositionError("no_capable_model")

    proposed, applied = full, []
    if not _fits(full, budget_usd, budget_tokens):
        for step in STEPS:
            proposed = _step(plan, step, proposed)
            applied.append(step)
            if _fits(proposed, budget_usd, budget_tokens):
                break
    fits = _fits(proposed, budget_usd, budget_tokens)
    status = "ok" if not applied else ("degraded" if fits else "refused")
    if any(a.cost is None for a in full):
        warnings.append({"code": "unpriced_models", "params": {}})

    result: dict[str, object] = {
        "status": status,
        "template": key,
        "template_source": source,
        "complexity": size,
        "signals": {**signals.to_dict(), "domains": domains},
        "hinted": hints is not None,
        "warnings": warnings,
        "budget": {"usd": budget_usd, "tokens": budget_tokens},
        "full": _summary(full, full),
        "steps": applied,
        "proposed": None,
        "minimum": None,
        "changes": [],
        "refinement": refinement_request(refine_text, usable[0])
        if refine_text
        else None,
    }
    if status == "refused":
        result["minimum"] = _summary(proposed, full)
        return result
    result["proposed"] = _summary(proposed, full)
    result["changes"] = _changes(full, proposed)
    result["delta_usd"] = round(_cost(full) - _cost(proposed), 4)
    result["delta_tokens"] = _tokens(full) - _tokens(proposed)
    return result


__all__ = ["STEPS", "CompositionError", "PlannedAgent", "suggest_composition"]
