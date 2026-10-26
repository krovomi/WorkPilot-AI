"""What a provider actually receives for the effort a task asks for.

The Kanban offers five levels (none, low, medium, high, ultrathink) on every
provider, and each provider has its own scale — or none at all. Before this
module, the task feed traced the level the person picked whatever happened to
it: a Grok, DeepSeek or Mistral phase on "high" said "Effort: high" and sent
nothing, and the picker offered the same five levels on Windsurf, where none
of them reaches the model. That is the false positive this module removes.

`effort_plan(provider, model, level)` is the single answer, read three ways:

- the clients send what it says (`core/client.py` builders);
- `_log_llm_context_switch` traces it, "(not applied by this model)" or
  "(sent as low)" when the level is not what the model receives;
- `GET /providers/effort` serves it to the picker (`EngineTrioPicker`).

`control` is one of:

- ``native``  the value is sent, as `sent` says;
- ``none``    the provider or model has no setting WorkPilot can reach: the
              level has no effect;
- ``runtime`` decided when the session starts, from what the server says the
              model takes (Copilot's `/models` bounds, Ollama's `/api/show`).
"""

from __future__ import annotations

from dataclasses import dataclass

LEVELS = ("none", "low", "medium", "high", "ultrathink")

NATIVE = "native"
NO_CONTROL = "none"
RUNTIME = "runtime"

# Provider spellings folded the way `core.client._normalize_provider_name` and
# the frontend do; the plan is keyed on one name per provider.
_ALIASES = {
    "anthropic": "claude",
    "agy": "antigravity",
    "gemini": "google",
    "lm-studio": "lmstudio",
    "llamacpp": "llama-cpp",
    "openai-codex": "openai",
}

_LOCAL = frozenset({"ollama", "local", "lmstudio", "llama-cpp"})
_COMPATIBLE = frozenset({"grok", "deepseek", "mistral"})
# No effort setting reaches these models: Windsurf's gRPC/REST bridge takes
# none, and `opencode run --variant` names variants per model that WorkPilot
# cannot know in advance.
_NO_EFFORT = frozenset({"windsurf", "opencode"})


@dataclass(frozen=True)
class EffortPlan:
    """What one level becomes on one provider and model."""

    control: str
    # The provider's own word for the level, as sent; None when nothing is
    # sent (no control, or the provider default is the closest match).
    sent: str | None


def canonical_provider(provider: str | None) -> str:
    name = (provider or "").strip().lower()
    return _ALIASES.get(name, name)


def _budget(level: str) -> int | None:
    from phase_config import THINKING_BUDGET_MAP

    return THINKING_BUDGET_MAP.get(level)


def _sent_from_params(params: dict | None) -> str | None:
    if not params:
        return None
    if "reasoning_effort" in params:
        return str(params["reasoning_effort"])
    thinking = params.get("thinking")
    if isinstance(thinking, dict) and thinking.get("type") == "disabled":
        return "off"
    return None


def effort_plan(provider: str | None, model: str | None, level: str) -> EffortPlan:
    """What `provider` receives on `model` for the Kanban `level`."""
    from core.llm_optimization import (
        claude_effort,
        compatible_effort_params,
        gemini_reasoning_effort,
        openai_reasoning_effort,
    )

    name = canonical_provider(provider)
    model_id = (model or "").strip()
    level = (level or "").strip().lower()
    if level not in LEVELS:
        level = "medium"
    budget = _budget(level)

    if name == "claude" or not name:
        return EffortPlan(NATIVE, claude_effort(budget))
    if name == "openai":
        effort = openai_reasoning_effort(model_id or "gpt-4o", budget)
        return EffortPlan(NATIVE if effort else NO_CONTROL, effort)
    if name == "google":
        effort = gemini_reasoning_effort(model_id or "gemini-2.5-pro", budget)
        return EffortPlan(NATIVE if effort else NO_CONTROL, effort)
    if name in _COMPATIBLE:
        # Asked at "high", the one level every effort-taking model answers:
        # a model without the setting answers nothing at any level.
        if compatible_effort_params(name, model_id, _budget("high")) is None:
            return EffortPlan(NO_CONTROL, None)
        sent = _sent_from_params(compatible_effort_params(name, model_id, budget))
        return EffortPlan(NATIVE, sent)
    if name == "pi":
        from core.agent_clients.pi_cli import pi_thinking_level

        return EffortPlan(NATIVE, pi_thinking_level(level))
    if name == "antigravity":
        from core.agent_clients.antigravity_cli import antigravity_effort

        if model_id and antigravity_effort("high", model_id) is None:
            # The slug names its own effort (`…-flash-medium`).
            return EffortPlan(NO_CONTROL, None)
        return EffortPlan(NATIVE, antigravity_effort(level, model_id))
    if name == "copilot" or name in _LOCAL:
        return EffortPlan(RUNTIME, None)
    if name in _NO_EFFORT:
        return EffortPlan(NO_CONTROL, None)
    # A provider without an adapter runs on the Claude SDK (`_degraded_client`).
    return EffortPlan(NATIVE, claude_effort(budget))


def effort_trace_label(provider: str | None, model: str | None, level: str) -> str:
    """The effort as the task feed should state it: the level, and the truth.

    Stable English: `translateLogMessage` localises the two suffixes.
    """
    if level not in LEVELS:
        return level
    plan = effort_plan(provider, model, level)
    if plan.control == NO_CONTROL:
        return level if level == "none" else f"{level} (not applied by this model)"
    if plan.control == NATIVE and plan.sent and plan.sent != level:
        return f"{level} (sent as {plan.sent})"
    return level


def describe_effort(provider: str | None, model: str | None) -> dict:
    """Every level's plan for one provider and model, as the API serves it."""
    plans = {level: effort_plan(provider, model, level) for level in LEVELS}
    controls = {plan.control for plan in plans.values()}
    control = controls.pop() if len(controls) == 1 else NATIVE
    return {
        "provider": canonical_provider(provider),
        "model": (model or "").strip(),
        "control": control,
        "levels": {level: plan.sent for level, plan in plans.items()},
    }
