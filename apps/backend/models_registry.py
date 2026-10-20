"""Centralized LLM model registry.

Single source of truth for the models WorkPilot ships with: ids, labels, tiers,
thinking support and provider defaults. Replaces hardcoded model strings
scattered across phase_config.py, provider_api.py and agent_client.py.

Prices are not here: `cost_intelligence/catalog.py` holds them, one row per
API model id, read from each provider's official pricing page. An id in this
registry is a provider's API model id, checked against its official model list
on the date given in its section; tests/cost_intelligence/test_catalog.py
checks that the catalog prices each one or says why not.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelEntry:
    """A single LLM model with metadata and routing info."""

    provider: str
    model_id: str
    label: str
    tier: str  # "flagship" | "standard" | "fast" | "local"
    supports_thinking: bool = False

    # Routing helpers
    is_default: bool = False
    base_url: str | None = None


# =============================================================================
# ANTHROPIC / CLAUDE MODELS
# https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-15.
# Every Claude model listed here takes extended or adaptive thinking.
# =============================================================================

_ANTHROPIC_MODELS = [
    ModelEntry(
        "anthropic",
        "claude-fable-5-1",
        "Claude Fable 5.1",
        "flagship",
        supports_thinking=True,
    ),
    # Claude Fable 5 — « Mythos-class » (GA 2026-06-09), au-dessus d'Opus 4.8.
    ModelEntry(
        "anthropic",
        "claude-fable-5",
        "Claude Fable 5",
        "flagship",
        supports_thinking=True,
    ),
    # Flagship. Claude Opus 5 is the current default: `get_default("anthropic")`
    # decides what an auto-configured provider runs, and it was still pointing
    # at Opus 4.5 — two generations behind what the catalogue already offered.
    ModelEntry(
        "anthropic",
        "claude-opus-5",
        "Claude Opus 5",
        "flagship",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-8",
        "Claude Opus 4.8",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-7",
        "Claude Opus 4.7",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-6",
        "Claude Opus 4.6",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-5-20251101",
        "Claude Opus 4.5",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-opus-4-5",
        "Claude Opus 4.5",
        "flagship",
        supports_thinking=True,
    ),
    # Standard
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-5-20250929",
        "Claude Sonnet 4.5",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-5",
        "Claude Sonnet 5",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        "standard",
        supports_thinking=True,
    ),
    # Fast
    ModelEntry(
        "anthropic",
        "claude-haiku-4-5-20251001",
        "Claude Haiku 4.5",
        "fast",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        "fast",
        supports_thinking=True,
    ),
    # The current generation, after the entries above so that each tier keeps
    # its representative (`get_tier`).
    ModelEntry(
        "anthropic",
        "claude-opus-5-5",
        "Claude Opus 5.5",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "anthropic",
        "claude-haiku-5-5",
        "Claude Haiku 5.5",
        "fast",
        supports_thinking=True,
    ),
]

# =============================================================================
# OPENAI MODELS
# https://developers.openai.com/api/docs/pricing and /deprecations, read
# 2026-10-15. Live discovery adds releases. o1, o1-pro, o3-mini, o4-mini,
# gpt-4.1-nano, gpt-4, gpt-4-turbo and gpt-3.5-turbo shut down on 2026-10-23.
# =============================================================================

_OPENAI_MODELS = [
    ModelEntry(
        "openai", "gpt-6-astra", "GPT-6 Astra", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "openai", "gpt-5.6-sol", "GPT-5.6 Sol", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "openai", "gpt-5.6-terra", "GPT-5.6 Terra", "standard", supports_thinking=True
    ),
    ModelEntry(
        "openai", "gpt-5.6-luna", "GPT-5.6 Luna", "fast", supports_thinking=True
    ),
    ModelEntry(
        "openai", "gpt-5.5-pro", "GPT-5.5 Pro", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "openai",
        "gpt-5.5",
        "GPT-5.5",
        "flagship",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry("openai", "gpt-5.2", "GPT-5.2", "flagship", supports_thinking=True),
    ModelEntry("openai", "gpt-4.1", "GPT-4.1", "flagship"),
    ModelEntry("openai", "gpt-4.1-mini", "GPT-4.1 Mini", "fast"),
    ModelEntry("openai", "gpt-4o", "GPT-4o", "standard"),
    ModelEntry("openai", "gpt-4o-mini", "GPT-4o Mini", "fast"),
    ModelEntry("openai", "o3", "O3", "flagship", supports_thinking=True),
    ModelEntry(
        "openai", "gpt-6.1-sol", "GPT-6.1 Sol", "standard", supports_thinking=True
    ),
    ModelEntry("openai", "gpt-6-luna", "GPT-6 Luna", "fast", supports_thinking=True),
    ModelEntry(
        "openai", "gpt-5.4-pro", "GPT-5.4 Pro", "flagship", supports_thinking=True
    ),
    ModelEntry("openai", "gpt-5.4", "GPT-5.4", "standard", supports_thinking=True),
    ModelEntry(
        "openai", "gpt-5.4-mini", "GPT-5.4 Mini", "fast", supports_thinking=True
    ),
]

# =============================================================================
# GOOGLE / GEMINI MODELS
# https://ai.google.dev/gemini-api/docs/models and /pricing, read 2026-10-15.
# 3.1 Pro and 3 Flash only exist under their -preview ids.
# =============================================================================

_GOOGLE_MODELS = [
    ModelEntry(
        "google",
        "gemini-3.1-pro-preview",
        "Gemini 3.1 Pro",
        "flagship",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "google",
        "gemini-3.8-flash",
        "Gemini 3.8 Flash",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "google",
        "gemini-3.1-flash-lite",
        "Gemini 3.1 Flash Lite",
        "fast",
        supports_thinking=True,
    ),
    ModelEntry(
        "google", "gemini-2.5-pro", "Gemini 2.5 Pro", "standard", supports_thinking=True
    ),
    ModelEntry(
        "google", "gemini-2.5-flash", "Gemini 2.5 Flash", "fast", supports_thinking=True
    ),
    ModelEntry(
        "google",
        "gemini-3-flash-preview",
        "Gemini 3 Flash",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "google", "gemini-4-argon", "Gemini 4 Argon", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "google",
        "gemini-3.5-flash-lite",
        "Gemini 3.5 Flash Lite",
        "fast",
        supports_thinking=True,
    ),
]

# =============================================================================
# MISTRAL MODELS
# https://docs.mistral.ai/models and each model's card, read 2026-10-15.
# =============================================================================

_MISTRAL_MODELS = [
    ModelEntry(
        "mistral", "mistral-large-2512", "Mistral Large 3", "flagship", is_default=True
    ),
    ModelEntry("mistral", "mistral-small-2603", "Mistral Small 4", "standard"),
    ModelEntry("mistral", "mistral-medium-3-5", "Mistral Medium 3.5", "flagship"),
    ModelEntry("mistral", "ministral-14b-2512", "Ministral 3 14B", "standard"),
    ModelEntry("mistral", "ministral-8b-2512", "Ministral 3 8B", "standard"),
    ModelEntry("mistral", "ministral-3b-2512", "Ministral 3 3B", "fast"),
    ModelEntry("mistral", "codestral-2508", "Codestral", "standard"),
    ModelEntry("mistral", "mistral-large-4", "Mistral Large 4 (preview)", "flagship"),
]

# =============================================================================
# DEEPSEEK MODELS
# https://api-docs.deepseek.com/quick_start/pricing, read 2026-10-15. The API
# serves two names; deepseek-chat and deepseek-reasoner retired on 2026-07-24.
# =============================================================================

_DEEPSEEK_MODELS = [
    ModelEntry(
        "deepseek",
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "deepseek",
        "deepseek-flash",
        "DeepSeek V4.1 Flash",
        "standard",
        supports_thinking=True,
        is_default=True,
    ),
]

# =============================================================================
# GROK MODELS
# https://docs.x.ai/developers/models and /pricing, read 2026-10-15. The
# slugs retired on 2026-05-15 (grok-4, grok-4-fast-*, grok-3…) are left out.
# =============================================================================

_GROK_MODELS = [
    ModelEntry(
        "grok",
        "grok-4.3",
        "Grok 4.3",
        "flagship",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "grok",
        "grok-4.20-reasoning",
        "Grok 4.20 Reasoning",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry("grok", "grok-4.7", "Grok 4.7", "flagship", supports_thinking=True),
    ModelEntry("grok", "grok-build-0.1", "Grok Build 0.1", "standard"),
]

# =============================================================================
# META / LLAMA MODELS
# =============================================================================

_META_MODELS = [
    ModelEntry("meta", "llama-3.3-70b", "Llama 3.3 70B", "standard"),
    ModelEntry("meta", "llama-3.1-8b", "Llama 3.1 8B", "fast"),
    ModelEntry("meta", "llama-3.1-70b", "Llama 3.1 70B", "standard"),
    ModelEntry("meta", "llama-4-maverick", "Llama 4 Maverick", "flagship"),
    ModelEntry(
        "meta",
        "meta-llama/llama-4-scout",
        "Meta Llama 4 Scout",
        "standard",
        is_default=True,
    ),
    ModelEntry("meta", "meta-llama/llama-3.3-70b", "Llama 3.3 70B", "standard"),
    ModelEntry("meta", "meta-llama/llama-3.1-70b", "Llama 3.1 70B", "standard"),
    ModelEntry("meta", "meta-llama/llama-3.1-8b", "Llama 3.1 8B", "fast"),
]

# =============================================================================
# OLLAMA MODELS (local/free)
# =============================================================================

_OLLAMA_MODELS = [
    ModelEntry("ollama", "qwen3-coder:30b", "Qwen3 Coder 30B", "local"),
    ModelEntry("ollama", "qwen3-coder-next", "Qwen3 Coder Next 80B", "local"),
    ModelEntry("ollama", "devstral-small-2:24b", "Devstral Small 2 24B", "local"),
    ModelEntry("ollama", "devstral-2:123b", "Devstral 2 123B", "local"),
    ModelEntry("ollama", "gpt-oss:20b", "GPT-OSS 20B", "local", supports_thinking=True),
    ModelEntry(
        "ollama", "gpt-oss:120b", "GPT-OSS 120B", "local", supports_thinking=True
    ),
    ModelEntry("ollama", "qwen3:8b", "Qwen3 8B", "local", supports_thinking=True),
    ModelEntry("ollama", "qwen3:14b", "Qwen3 14B", "local", supports_thinking=True),
    ModelEntry("ollama", "qwen3:30b", "Qwen3 30B", "local", supports_thinking=True),
    ModelEntry("ollama", "qwen3:32b", "Qwen3 32B", "local", supports_thinking=True),
    ModelEntry("ollama", "qwen2.5-coder:7b", "Qwen 2.5 Coder 7B", "local"),
    ModelEntry("ollama", "qwen2.5-coder:14b", "Qwen 2.5 Coder 14B", "local"),
    ModelEntry("ollama", "qwen2.5-coder:32b", "Qwen 2.5 Coder 32B", "local"),
    ModelEntry("ollama", "llama3.3", "Llama 3.3", "local", is_default=True),
    ModelEntry("ollama", "deepseek-coder-v2", "DeepSeek Coder V2", "local"),
    ModelEntry("ollama", "llama3.2", "Llama 3.2", "local"),
    ModelEntry("ollama", "llama3.1", "Llama 3.1", "local"),
    ModelEntry("ollama", "mistral-large-3", "Mistral Large 3", "local"),
    ModelEntry("ollama", "mistral", "Mistral", "local"),
    ModelEntry("ollama", "mistral-large", "Mistral Large", "local"),
    ModelEntry("ollama", "deepseek-v3.2", "DeepSeek V3.2", "local"),
    ModelEntry(
        "ollama", "deepseek-r2", "DeepSeek R2", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "ollama", "deepseek-r1", "DeepSeek R1", "standard", supports_thinking=True
    ),
    ModelEntry("ollama", "qwen2.5-coder", "Qwen 2.5 Coder", "local"),
    ModelEntry("ollama", "qwen2.5", "Qwen 2.5", "local"),
    ModelEntry("ollama", "phi4", "Phi-4", "local"),
    ModelEntry("ollama", "gemma3", "Gemma 3", "local"),
    ModelEntry("ollama", "gemma2", "Gemma 2", "local"),
    ModelEntry("ollama", "codellama", "CodeLlama", "local"),
    ModelEntry("ollama", "yi", "Yi", "local"),
    ModelEntry("ollama", "mixtral", "Mixtral", "local"),
    ModelEntry("ollama", "vicuna", "Vicuna", "local"),
    ModelEntry("ollama", "wizardlm", "WizardLM", "local"),
    ModelEntry("ollama", "solar", "Solar Pro", "local"),
    ModelEntry("ollama", "custom", "Autre (saisie libre)", "local"),
]

# =============================================================================
# WINDSURF / CODEIUM MODELS
# =============================================================================

# Model IDs are the friendly slugs resolved by integrations/windsurf_proxy/models.py
# (MODEL_NAME_TO_ENUM). The previous values were internal MODEL_<ENUM> placeholder
# names which are NOT valid model identifiers and broke the Windsurf provider.
_WINDSURF_MODELS = [
    ModelEntry("windsurf", "swe-1.6-fast", "SWE 1.6 Fast", "fast", is_default=True),
    ModelEntry("windsurf", "swe-1.6", "SWE 1.6", "flagship"),
    ModelEntry("windsurf", "swe-1.5", "SWE 1.5", "flagship"),
    ModelEntry(
        "windsurf",
        "swe-1.5-thinking",
        "SWE 1.5 Thinking",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "windsurf",
        "claude-opus-4",
        "Claude Opus 4 (Windsurf)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "windsurf",
        "claude-sonnet-4",
        "Claude Sonnet 4 (Windsurf)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "windsurf",
        "claude-3.7-sonnet",
        "Claude 3.7 Sonnet (Windsurf)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry("windsurf", "gpt-4.1", "GPT-4.1 (Windsurf)", "standard"),
    ModelEntry("windsurf", "gpt-4o", "GPT-4o (Windsurf)", "standard"),
    ModelEntry(
        "windsurf",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro (Windsurf)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "windsurf",
        "deepseek-r1",
        "DeepSeek R1 (Windsurf)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry("windsurf", "deepseek-v3", "DeepSeek V3 (Windsurf)", "standard"),
    ModelEntry("windsurf", "gemini-2.0-flash", "Gemini 2.0 Flash (Windsurf)", "fast"),
    ModelEntry("windsurf", "swe-1.5-fast", "SWE 1.5 Fast", "fast"),
]

# =============================================================================
# AWS BEDROCK MODELS
# Base model ids from the Bedrock model cards
# (https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html), read
# 2026-10-15. Ids from Claude 4.7 on carry no -v1 suffix; the Llama models are
# legacy until 2027-03-30.
# =============================================================================

_AWS_MODELS = [
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-8",
        "Claude Opus 4.8 (Bedrock)",
        "flagship",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-fable-5",
        "Claude Fable 5 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-6-v1",
        "Claude Opus 4.6 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-sonnet-4-6",
        "Claude Sonnet 4.6 (Bedrock)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "meta.llama3-3-70b-instruct-v1:0",
        "Llama 3.3 70B (Bedrock)",
        "standard",
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-4-7",
        "Claude Opus 4.7 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-sonnet-4-5-20250929-v1:0",
        "Claude Sonnet 4.5 (Bedrock)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws", "meta.llama3-70b-instruct-v1:0", "Llama 3 70B (Bedrock)", "standard"
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-fable-5-1",
        "Claude Fable 5.1 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-5-5",
        "Claude Opus 5.5 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-opus-5",
        "Claude Opus 5 (Bedrock)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-sonnet-5-5",
        "Claude Sonnet 5.5 (Bedrock)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-sonnet-5",
        "Claude Sonnet 5 (Bedrock)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "aws",
        "anthropic.claude-haiku-5-5",
        "Claude Haiku 5.5 (Bedrock)",
        "fast",
        supports_thinking=True,
    ),
]


# =============================================================================
# COPILOT MODELS
# Source: docs.github.com/en/copilot/reference/ai-models/supported-models
# =============================================================================

_COPILOT_MODELS = [
    ModelEntry(
        "copilot",
        "claude-opus-4.8",
        "Claude Opus 4.8 (Copilot)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.7",
        "Claude Opus 4.7 (Copilot)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.6",
        "Claude Opus 4.6 (Copilot)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "copilot",
        "claude-opus-4.5",
        "Claude Opus 4.5 (Copilot)",
        "flagship",
        supports_thinking=True,
    ),
    ModelEntry(
        "copilot", "gpt-5.5", "GPT-5.5 (Copilot)", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "copilot", "gpt-5.4", "GPT-5.4 (Copilot)", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "copilot",
        "claude-sonnet-4.6",
        "Claude Sonnet 4.6 (Copilot)",
        "standard",
        supports_thinking=True,
        is_default=True,
    ),
    ModelEntry(
        "copilot",
        "claude-sonnet-4.5",
        "Claude Sonnet 4.5 (Copilot)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry("copilot", "gpt-4.1", "GPT-4.1 (Copilot)", "standard"),
    ModelEntry("copilot", "gpt-4o", "GPT-4o (Copilot)", "standard"),
    ModelEntry(
        "copilot", "o4-mini", "o4-mini (Copilot)", "standard", supports_thinking=True
    ),
    ModelEntry("copilot", "o3", "o3 (Copilot)", "standard", supports_thinking=True),
    ModelEntry(
        "copilot", "o3-mini", "o3-mini (Copilot)", "standard", supports_thinking=True
    ),
    ModelEntry("copilot", "o1", "o1 (Copilot)", "standard", supports_thinking=True),
    ModelEntry(
        "copilot",
        "claude-3.7-sonnet",
        "Claude 3.7 Sonnet (Copilot)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry(
        "copilot",
        "gemini-2.5-pro",
        "Gemini 2.5 Pro (Copilot)",
        "standard",
        supports_thinking=True,
    ),
    ModelEntry("copilot", "claude-haiku-4.5", "Claude Haiku 4.5 (Copilot)", "fast"),
    ModelEntry("copilot", "gemini-2.0-flash", "Gemini 2.0 Flash (Copilot)", "fast"),
    ModelEntry("copilot", "gpt-4.1-mini", "GPT-4.1 mini (Copilot)", "fast"),
    ModelEntry(
        "copilot", "o1-mini", "o1-mini (Copilot)", "fast", supports_thinking=True
    ),
    ModelEntry("copilot", "gpt-4o-mini", "GPT-4o mini (Copilot)", "fast"),
]

# =============================================================================
# CURSOR MODELS
# =============================================================================

_CURSOR_MODELS = [
    ModelEntry(
        "cursor", "cursor-default", "Cursor Default", "standard", is_default=True
    ),
]

# =============================================================================
# CUSTOM GATEWAY (ANTHROPIC_BASE_URL)
# =============================================================================

_CUSTOM_MODELS = [
    ModelEntry(
        "custom", "custom-model-1", "Custom Model 1", "flagship", supports_thinking=True
    ),
    ModelEntry(
        "custom", "custom-model-2", "Custom Model 2", "standard", supports_thinking=True
    ),
    ModelEntry("custom", "custom-model-3", "Custom Model 3", "fast"),
    ModelEntry(
        "custom", "custom", "Autre (saisie libre)", "local", supports_thinking=True
    ),
]

# =============================================================================
# REGISTRY
# =============================================================================

REGISTRY: tuple[ModelEntry, ...] = tuple(
    _ANTHROPIC_MODELS
    + _OPENAI_MODELS
    + _GOOGLE_MODELS
    + _MISTRAL_MODELS
    + _DEEPSEEK_MODELS
    + _GROK_MODELS
    + _META_MODELS
    + _OLLAMA_MODELS
    + _WINDSURF_MODELS
    + _AWS_MODELS
    + _COPILOT_MODELS
    + _CURSOR_MODELS
    + _CUSTOM_MODELS
)

# =============================================================================
# HELPERS
# =============================================================================


def get_default(provider: str) -> ModelEntry | None:
    """Get the default model for a provider."""
    for entry in REGISTRY:
        if entry.provider == provider and entry.is_default:
            return entry
    return None


def get_tier(provider: str, tier: str) -> ModelEntry | None:
    """Get the representative model for a provider + tier combination."""
    for entry in REGISTRY:
        if entry.provider == provider and entry.tier == tier:
            return entry
    return None


def list_provider(provider: str) -> list[ModelEntry]:
    """List all models for a provider."""
    return [e for e in REGISTRY if e.provider == provider]


def provider_catalog() -> dict[str, list[dict[str, object]]]:
    """Serializable catalogue shared by the API and generated frontend fallback."""
    result: dict[str, list[dict[str, object]]] = {}
    for model in REGISTRY:
        result.setdefault(model.provider, []).append(
            {
                "value": model.model_id,
                "label": model.label,
                "tier": model.tier,
                "supportsThinking": model.supports_thinking,
            }
        )
    for alias, provider in {
        "claude": "anthropic",
        "gemini": "google",
        "local": "ollama",
    }.items():
        result[alias] = result[provider]
    # These runtimes expose their actual inventory through live discovery.
    result.setdefault("lmstudio", [])
    result.setdefault("lm-studio", [])
    result.setdefault("llama-cpp", [])
    result.setdefault("custom", [])
    return result
