"""Adaptive Model Router.

Picks a (provider, model) for a given task based on task class, prompt
size, and a quality/cost tradeoff. Backed by `cost_intelligence.PricingCatalog`
for live pricing data.

The router is intentionally simple: a heuristic decision table that can be
overridden via a `RoutingPolicy`. A real production version would learn the
mapping from execution history (the analytics database), but the heuristic
version already captures 80% of the savings — refactor 50 lines should not
spend Opus tokens.

Measured evidence, when the project has it, goes first: the repo bench
(`bench/`) replays finished cards and judges them with their own tests. A
model it saw resolve less than half of at least three distinct cards is
passed over, and the choice's reason says so (`bench_scores`). When the
bench judged the model on enough cards of the task's kind, those cards are
the evidence (`bench.scores(project, kind)`).

The models come from `models_registry` (`tier_pick`): budget work goes to a
provider's ``fast`` model, balanced to ``standard``, premium to ``flagship``,
and the next tier when a provider has none. A router told which providers the
user has (`available`) never suggests a model of another one: a task that
runs on Mistral gets a Mistral model or nothing. A provider billed per seat
(Copilot, Windsurf, Cursor) or running locally (Ollama) has no per-token
price; its choice costs $0 and says why.

Every choice carries ``reason_code`` and ``reason_params`` beside its English
``reason``, so the app words the reason in its own language.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum

from bench.results import router_verdict
from cost_intelligence.catalog import UNPRICED_PROVIDERS, PricingCatalog
from models_registry import tier_pick

logger = logging.getLogger(__name__)


class TaskClass(str, Enum):
    """Coarse task buckets — what kind of work the agent is doing."""

    TRIVIAL = "trivial"  # rename, fix typo, format
    SIMPLE_EDIT = "simple_edit"  # single-file change, < 100 LoC
    MULTI_FILE = "multi_file"  # 2-10 file refactor
    ARCHITECTURE = "architecture"  # design decision, system-wide change
    REVIEW = "review"  # code review, QA
    PLANNING = "planning"  # task decomposition
    IDEATION = "ideation"  # brainstorm, exploration
    DOCUMENTATION = "documentation"


class QualityTier(str, Enum):
    """How much we care about output quality vs cost."""

    BUDGET = "budget"  # cheapest model that probably works
    BALANCED = "balanced"  # default — reasonable quality at reasonable cost
    PREMIUM = "premium"  # best available, cost no object


@dataclass(frozen=True)
class ModelChoice:
    """The router's decision for a single dispatch."""

    provider: str
    model: str
    task_class: TaskClass
    tier: QualityTier
    estimated_cost_usd: float
    reason: str
    # ``tier_for_task`` | ``unpriced_provider`` | ``fallback`` | ``no_model``
    reason_code: str = "tier_for_task"
    reason_params: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "model": self.model,
            "task_class": self.task_class.value,
            "tier": self.tier.value,
            "estimated_cost_usd": round(self.estimated_cost_usd, 6),
            "reason": self.reason,
            "reason_code": self.reason_code,
            "reason_params": self.reason_params,
        }


#: Providers the default policy walks, in this order, for every tier.
ROUTABLE_PROVIDERS: tuple[str, ...] = (
    "anthropic",
    "openai",
    "google",
    "mistral",
    "deepseek",
    "grok",
    "openrouter",
    "huggingface",
    "copilot",
    "windsurf",
    "cursor",
    "aws",
    "meta",
    "ollama",
)

#: Names the app or the task metadata use for a provider of the registry.
PROVIDER_ALIASES: dict[str, str] = {
    "claude": "anthropic",
    "gemini": "google",
    "local": "ollama",
    "lmstudio": "ollama",
    "lm-studio": "ollama",
    "xai": "grok",
    "github-copilot": "copilot",
    "bedrock": "aws",
}

#: Registry tiers tried for each quality tier, in order.
_REGISTRY_TIERS: dict[str, tuple[str, ...]] = {
    "budget": ("fast", "standard", "local", "flagship"),
    "balanced": ("standard", "flagship", "local", "fast"),
    "premium": ("flagship", "standard", "local"),
}


def normalize_provider(name: str) -> str:
    lowered = (name or "").strip().lower()
    return PROVIDER_ALIASES.get(lowered, lowered)


def _registry_chain(tier: str) -> list[tuple[str, str]]:
    chain: list[tuple[str, str]] = []
    for provider in ROUTABLE_PROVIDERS:
        for registry_tier in _REGISTRY_TIERS[tier]:
            entry = tier_pick(provider, registry_tier)
            if entry is not None:
                chain.append((provider, entry.model_id))
                break
    return chain


@dataclass
class RoutingPolicy:
    """Per-task-class preferred model lists, in fallback order.

    Each entry is `(provider, model)`. The router walks the list and picks
    the first one available in the catalog (i.e. for which we know pricing
    AND that the user has configured locally).
    """

    budget: dict[TaskClass, list[tuple[str, str]]] = field(default_factory=dict)
    balanced: dict[TaskClass, list[tuple[str, str]]] = field(default_factory=dict)
    premium: dict[TaskClass, list[tuple[str, str]]] = field(default_factory=dict)

    @classmethod
    def default(cls) -> RoutingPolicy:
        """One chain per tier, read from ``models_registry.tier_pick``.

        All task classes share the chain of their tier; callers can
        specialise per class with a policy of their own.
        """
        budget = dict.fromkeys(TaskClass, _registry_chain("budget"))
        balanced = dict.fromkeys(TaskClass, _registry_chain("balanced"))
        premium = dict.fromkeys(TaskClass, _registry_chain("premium"))
        return cls(budget=budget, balanced=balanced, premium=premium)

    def chain_for(self, tier: QualityTier, task: TaskClass) -> list[tuple[str, str]]:
        table = {
            QualityTier.BUDGET: self.budget,
            QualityTier.BALANCED: self.balanced,
            QualityTier.PREMIUM: self.premium,
        }[tier]
        return table.get(task, [])


# Heuristic mapping: (task_class, prompt_size_chars) -> default tier.
# Smaller inputs + simpler classes downgrade towards BUDGET.
def _default_tier(task: TaskClass, prompt_chars: int) -> QualityTier:
    if task in (TaskClass.TRIVIAL, TaskClass.SIMPLE_EDIT):
        return QualityTier.BUDGET
    if task in (TaskClass.ARCHITECTURE, TaskClass.PLANNING):
        return QualityTier.PREMIUM
    if task == TaskClass.MULTI_FILE and prompt_chars > 50_000:
        return QualityTier.PREMIUM
    return QualityTier.BALANCED


def classify_task(prompt: str, hint: str | None = None) -> TaskClass:
    """Best-effort classification from a free-form prompt.

    `hint` lets the caller force a class explicitly (e.g. an agent that
    knows it is doing a "review" passes hint="review").
    """
    if hint:
        try:
            return TaskClass(hint.lower())
        except ValueError:
            pass

    p = (prompt or "").lower()
    # Order matters: more specific first.
    if any(kw in p for kw in ("typo", "rename", "format", "lint")):
        return TaskClass.TRIVIAL
    if any(kw in p for kw in ("review", "audit", "qa", "lgtm")):
        return TaskClass.REVIEW
    if any(kw in p for kw in ("plan", "decompose", "breakdown", "subtask")):
        return TaskClass.PLANNING
    if any(kw in p for kw in ("architect", "design", "trade-off", "tradeoff")):
        return TaskClass.ARCHITECTURE
    if any(kw in p for kw in ("brainstorm", "ideate", "explore")):
        return TaskClass.IDEATION
    if any(kw in p for kw in ("docstring", "readme", "documentation")):
        return TaskClass.DOCUMENTATION
    if len(prompt) > 8_000:
        return TaskClass.MULTI_FILE
    return TaskClass.SIMPLE_EDIT


class ModelRouter:
    """Routes a task to the cheapest acceptable model.

    Usage:

        router = ModelRouter(available={"anthropic", "openai"})
        choice = router.route(prompt="rename foo to bar", hint="trivial")
        # choice.model == "claude-haiku-4-5"
    """

    def __init__(
        self,
        available: Iterable[str] | None = None,
        catalog: PricingCatalog | None = None,
        policy: RoutingPolicy | None = None,
        bench_scores: dict[tuple[str, str], dict] | None = None,
    ) -> None:
        self.available = {normalize_provider(p) for p in (available or [])} or None
        self.catalog = catalog or PricingCatalog()
        self.policy = policy or RoutingPolicy.default()
        # ``bench.scores(project)``: {(provider, model): {resolved, judged, cases}}.
        self.bench_scores = bench_scores or {}

    def _bench(self, provider: str, model: str) -> dict | None:
        return self.bench_scores.get((provider.lower(), model))

    def _params(
        self, provider: str, model: str, passed: list[str], **extra: object
    ) -> dict[str, object]:
        params: dict[str, object] = {"provider": provider, **extra}
        score = self._bench(provider, model) if model else None
        if score:
            params["bench_resolved"] = score["resolved"]
            params["bench_judged"] = score["judged"]
            if score.get("kind"):
                params["bench_kind"] = score["kind"]
        if passed:
            params["passed_over"] = list(passed)
        return params

    def _with_bench(
        self, reason: str, provider: str, model: str, passed: list[str]
    ) -> str:
        score = self._bench(provider, model)
        if score:
            reason += f"; bench {score['resolved']}/{score['judged']} resolved"
            if score.get("kind"):
                reason += f" on {score['kind']} cards"
        if passed:
            reason += "; passed over on bench evidence: " + ", ".join(passed)
        return reason

    def route(
        self,
        prompt: str = "",
        hint: str | None = None,
        tier: QualityTier | None = None,
        expected_output_tokens: int = 1_000,
    ) -> ModelChoice:
        """Pick the cheapest available model for this task."""
        task = classify_task(prompt, hint=hint)
        chosen_tier = tier or _default_tier(task, len(prompt or ""))

        chain = self.policy.chain_for(chosen_tier, task)
        passed: list[str] = []
        for provider, model in chain:
            if self.available is not None and provider not in self.available:
                continue
            score = self._bench(provider, model)
            if score and router_verdict(score):
                scope = f"{score['kind']} cards" if score.get("kind") else "cards"
                passed.append(
                    f"{provider}/{model} ({score['resolved']}/{score['judged']} "
                    f"on {score['cases']} {scope})"
                )
                continue
            pricing = self.catalog.get_pricing(provider, model)
            if pricing is None or provider in UNPRICED_PROVIDERS:
                # No per-token price: a local runtime or a seat-billed
                # provider. Only when the user made it available.
                if self.available and provider in self.available:
                    why = "local" if provider == "ollama" else "subscription"
                    return ModelChoice(
                        provider=provider,
                        model=model,
                        task_class=task,
                        tier=chosen_tier,
                        estimated_cost_usd=0.0,
                        reason=self._with_bench(
                            f"{why} provider {provider} (no per-token price)",
                            provider,
                            model,
                            passed,
                        ),
                        reason_code="unpriced_provider",
                        reason_params=self._params(
                            provider, model, passed, billing=why
                        ),
                    )
                continue
            input_tokens = max(1, len(prompt) // 4)  # ~4 chars/token rule of thumb
            cost = pricing.cost_for_tokens(
                input_tokens=input_tokens,
                output_tokens=expected_output_tokens,
            )
            return ModelChoice(
                provider=provider,
                model=model,
                task_class=task,
                tier=chosen_tier,
                estimated_cost_usd=cost,
                reason=self._with_bench(
                    f"{chosen_tier.value} tier for {task.value}",
                    provider,
                    model,
                    passed,
                ),
                reason_code="tier_for_task",
                reason_params=self._params(provider, model, passed),
            )

        # The user named providers and none of them has a model in the
        # registry (a coding-agent CLI that picks its own, a custom gateway):
        # suggesting another provider's model would run nowhere.
        if self.available is not None:
            provider = sorted(self.available)[0]
            return ModelChoice(
                provider=provider,
                model="",
                task_class=task,
                tier=chosen_tier,
                estimated_cost_usd=0.0,
                reason=self._with_bench(
                    "no model of the available providers in the catalog",
                    provider,
                    "",
                    passed,
                ),
                reason_code="no_model",
                reason_params=self._params(
                    provider, "", passed, providers=sorted(self.available)
                ),
            )

        # Nothing in the chain is priced — fall back to the first entry of
        # the BALANCED tier so callers always get a non-None choice.
        fallback_chain = self.policy.chain_for(QualityTier.BALANCED, task)
        if not fallback_chain:
            raise RuntimeError("RoutingPolicy has no balanced fallback configured")
        provider, model = fallback_chain[0]
        return ModelChoice(
            provider=provider,
            model=model,
            task_class=task,
            tier=QualityTier.BALANCED,
            estimated_cost_usd=0.0,
            reason=self._with_bench(
                "no available provider matched preferred chain — using fallback",
                provider,
                model,
                passed,
            ),
            reason_code="fallback",
            reason_params=self._params(provider, model, passed),
        )

    def compare(
        self,
        prompt: str = "",
        hint: str | None = None,
        expected_output_tokens: int = 1_000,
    ) -> dict[str, ModelChoice]:
        """Return one ModelChoice per tier — useful for showing 'this would cost X with Haiku, Y with Opus'."""
        return {
            tier.value: self.route(
                prompt=prompt,
                hint=hint,
                tier=tier,
                expected_output_tokens=expected_output_tokens,
            )
            for tier in QualityTier
        }
