"""
The static provider catalogue: each provider's label, category and models.

Read by `shared_board/engines.py`, which offers these models on the phone's
New card screen (`GET /api/board/engines`). It says nothing about whether a
provider is configured on this machine: that is `core.auth` and
`capabilities/providers.yaml`.
"""

from typing import Any

# Constants for commonly used model names to avoid duplication
GPT_4_1 = "gpt-4.1"
GEMINI_2_5_PRO = "gemini-2.5-pro"


class Provider:
    def __init__(
        self,
        name: str,
        label: str,
        description: str,
        category: str,
        requires_api_key: bool = False,
        requires_oauth: bool = False,
        requires_cli: bool = False,
        models: list[dict[str, Any]] = None,
    ):
        self.name = name
        self.label = label
        self.description = description
        self.category = category
        self.requires_api_key = requires_api_key
        self.requires_oauth = requires_oauth
        self.requires_cli = requires_cli
        self.models = models or []


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, Provider] = {}
        self._initialize_providers()

    def _initialize_providers(self):
        """Initialise tous les providers disponibles"""

        # --- Anthropic (Claude) ---
        self._providers["anthropic"] = Provider(
            name="anthropic",
            label="Anthropic (Claude)",
            description="Claude models via Anthropic API",
            category="anthropic",
            requires_api_key=True,
            requires_oauth=True,
            requires_cli=False,
            models=[
                {
                    "value": "claude-fable-5",
                    "label": "Claude Fable 5",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4-6",
                    "label": "Claude Opus 4.6",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-sonnet-5",
                    "label": "Claude Sonnet 5",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-sonnet-4-6",
                    "label": "Claude Sonnet 4.6",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4-5-20251101",
                    "label": "Claude Opus 4.5",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-sonnet-4-5-20250929",
                    "label": "Claude Sonnet 4.5",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-haiku-4-5-20251001",
                    "label": "Claude Haiku 4.5",
                    "tier": "fast",
                    "supportsThinking": False,
                },
            ],
        )

        # --- OpenAI ---
        # Source: platform.openai.com/docs/models
        self._providers["openai"] = Provider(
            name="openai",
            label="OpenAI (ChatGPT)",
            description="GPT and o-series models via OpenAI API",
            category="openai",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "gpt-5.5-pro",
                    "label": "GPT-5.5 Pro",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-5.5",
                    "label": "GPT-5.5",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-5.5-mini",
                    "label": "GPT-5.5 mini",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-5.2",
                    "label": "GPT-5.2",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "o4",
                    "label": "o4",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "o4-mini",
                    "label": "o4-mini",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {"value": GPT_4_1, "label": "GPT-4.1", "tier": "standard"},
                {"value": "gpt-4.1-mini", "label": "GPT-4.1 mini", "tier": "fast"},
            ],
        )

        # --- Google Gemini ---
        self._providers["google"] = Provider(
            name="google",
            label="Google (Gemini)",
            description="Gemini models via Google AI",
            category="google",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "gemini-3.1-pro",
                    "label": "Gemini 3.1 Pro",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gemini-3-flash",
                    "label": "Gemini 3 Flash",
                    "tier": "flagship",
                },
                {
                    "value": "gemini-3.1-flash-lite",
                    "label": "Gemini 3.1 Flash-Lite",
                    "tier": "standard",
                },
                {
                    "value": GEMINI_2_5_PRO,
                    "label": "Gemini 2.5 Pro",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gemini-2.5-flash",
                    "label": "Gemini 2.5 Flash",
                    "tier": "fast",
                },
                {
                    "value": "gemini-2.0-flash-thinking",
                    "label": "Gemini 2.0 Flash Thinking",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "gemini-1.5-pro",
                    "label": "Gemini 1.5 Pro",
                    "tier": "standard",
                },
                {
                    "value": "gemini-1.5-flash",
                    "label": "Gemini 1.5 Flash",
                    "tier": "fast",
                },
            ],
        )

        # --- Meta (LLaMA) ---
        self._providers["meta"] = Provider(
            name="meta",
            label="Meta (LLaMA)",
            description="LLaMA models via Meta API / Replicate",
            category="meta",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "meta-llama/llama-4-scout",
                    "label": "Llama 4 Scout",
                    "tier": "flagship",
                },
                {
                    "value": "meta-llama/llama-3.3-70b",
                    "label": "Llama 3.3 70B",
                    "tier": "standard",
                },
                {
                    "value": "meta-llama/llama-3.1-70b",
                    "label": "Llama 3.1 70B",
                    "tier": "standard",
                },
                {
                    "value": "meta-llama/llama-3.1-8b",
                    "label": "Llama 3.1 8B",
                    "tier": "fast",
                },
            ],
        )

        # --- Mistral AI ---
        self._providers["mistral"] = Provider(
            name="mistral",
            label="Mistral AI",
            description="Mistral models via Mistral AI API",
            category="special",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "mistral-large-3",
                    "label": "Mistral Large 3",
                    "tier": "flagship",
                },
                {
                    "value": "ministral-3-14b",
                    "label": "Ministral 3 14B",
                    "tier": "standard",
                },
                {
                    "value": "ministral-3-8b",
                    "label": "Ministral 3 8B",
                    "tier": "standard",
                },
                {"value": "ministral-3-3b", "label": "Ministral 3 3B", "tier": "fast"},
                {
                    "value": "mistral-medium-3",
                    "label": "Mistral Medium 3",
                    "tier": "standard",
                },
                {
                    "value": "mistral-small-3",
                    "label": "Mistral Small 3",
                    "tier": "fast",
                },
                {"value": "codestral", "label": "Codestral", "tier": "standard"},
                {"value": "mistral-7b", "label": "Mistral 7B", "tier": "fast"},
            ],
        )

        # --- DeepSeek ---
        self._providers["deepseek"] = Provider(
            name="deepseek",
            label="DeepSeek",
            description="DeepSeek models via DeepSeek API",
            category="special",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "deepseek-v3.2",
                    "label": "DeepSeek V3.2",
                    "tier": "flagship",
                },
                {
                    "value": "deepseek-r2",
                    "label": "DeepSeek R2",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {"value": "deepseek-v3", "label": "DeepSeek V3", "tier": "standard"},
                {
                    "value": "deepseek-r1",
                    "label": "DeepSeek R1",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "deepseek-coder-v2",
                    "label": "DeepSeek Coder V2",
                    "tier": "standard",
                },
            ],
        )

        # --- AWS Bedrock ---
        self._providers["aws"] = Provider(
            name="aws",
            label="AWS (Bedrock)",
            description="Models via AWS Bedrock",
            category="aws",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "anthropic.claude-fable-5",
                    "label": "Claude Fable 5 (Bedrock)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "anthropic.claude-opus-4-8-v1",
                    "label": "Claude Opus 4.8 (Bedrock)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "anthropic.claude-opus-4-7-v1",
                    "label": "Claude Opus 4.7 (Bedrock)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "anthropic.claude-opus-4-6-v1",
                    "label": "Claude Opus 4.6 (Bedrock)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "anthropic.claude-sonnet-4-6-v1",
                    "label": "Claude Sonnet 4.6 (Bedrock)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "anthropic.claude-sonnet-4-5-v1",
                    "label": "Claude Sonnet 4.5 (Bedrock)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "amazon.titan-text-premier-v1",
                    "label": "Amazon Titan Premier",
                    "tier": "standard",
                },
                {
                    "value": "meta.llama3-70b-instruct-v1",
                    "label": "Llama 3 70B (Bedrock)",
                    "tier": "standard",
                },
            ],
        )

        # --- Ollama (Local) ---
        self._providers["ollama"] = Provider(
            name="ollama",
            label="Ollama (Local)",
            description="Locally hosted models via Ollama",
            category="local",
            requires_api_key=False,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "qwen3-coder:30b",
                    "label": "Qwen3 Coder 30B",
                    "tier": "local",
                },
                {
                    "value": "qwen3-coder-next",
                    "label": "Qwen3 Coder Next 80B",
                    "tier": "local",
                },
                {
                    "value": "devstral-small-2:24b",
                    "label": "Devstral Small 2 24B",
                    "tier": "local",
                },
                {
                    "value": "devstral-2:123b",
                    "label": "Devstral 2 123B",
                    "tier": "local",
                },
                {
                    "value": "gpt-oss:20b",
                    "label": "GPT-OSS 20B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-oss:120b",
                    "label": "GPT-OSS 120B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "qwen3:8b",
                    "label": "Qwen3 8B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "qwen3:14b",
                    "label": "Qwen3 14B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "qwen3:30b",
                    "label": "Qwen3 30B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "qwen3:32b",
                    "label": "Qwen3 32B",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "qwen2.5-coder:7b",
                    "label": "Qwen 2.5 Coder 7B",
                    "tier": "local",
                },
                {
                    "value": "qwen2.5-coder:14b",
                    "label": "Qwen 2.5 Coder 14B",
                    "tier": "local",
                },
                {
                    "value": "qwen2.5-coder:32b",
                    "label": "Qwen 2.5 Coder 32B",
                    "tier": "local",
                },
                {"value": "llama3.3", "label": "Llama 3.3", "tier": "local"},
                {"value": "llama3.2", "label": "Llama 3.2", "tier": "local"},
                {"value": "llama3.1", "label": "Llama 3.1", "tier": "local"},
                {
                    "value": "mistral-large-3",
                    "label": "Mistral Large 3",
                    "tier": "local",
                },
                {"value": "mistral", "label": "Mistral", "tier": "local"},
                {"value": "mistral-large", "label": "Mistral Large", "tier": "local"},
                {"value": "deepseek-v3.2", "label": "DeepSeek V3.2", "tier": "local"},
                {
                    "value": "deepseek-r2",
                    "label": "DeepSeek R2",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "deepseek-r1",
                    "label": "DeepSeek R1",
                    "tier": "local",
                    "supportsThinking": True,
                },
                {
                    "value": "deepseek-coder-v2",
                    "label": "DeepSeek Coder V2",
                    "tier": "local",
                },
                {"value": "qwen2.5-coder", "label": "Qwen 2.5 Coder", "tier": "local"},
                {"value": "qwen2.5", "label": "Qwen 2.5", "tier": "local"},
                {"value": "phi4", "label": "Phi-4", "tier": "local"},
                {"value": "gemma3", "label": "Gemma 3", "tier": "local"},
                {"value": "gemma2", "label": "Gemma 2", "tier": "local"},
                {"value": "codellama", "label": "CodeLlama", "tier": "local"},
                {"value": "yi", "label": "Yi", "tier": "local"},
                {"value": "mixtral", "label": "Mixtral", "tier": "local"},
                {"value": "vicuna", "label": "Vicuna", "tier": "local"},
                {"value": "wizardlm", "label": "WizardLM", "tier": "local"},
                {"value": "solar", "label": "Solar Pro", "tier": "local"},
                {"value": "custom", "label": "Autre (saisie libre)", "tier": "local"},
            ],
        )

        # --- GitHub Copilot ---
        # Source: docs.github.com/en/copilot/reference/ai-models/supported-models
        self._providers["copilot"] = Provider(
            name="copilot",
            label="GitHub Copilot",
            description="GitHub Copilot CLI models (gh copilot)",
            category="special",
            requires_api_key=False,
            requires_oauth=False,
            requires_cli=True,  # Requiert gh CLI
            models=[
                {
                    "value": "claude-opus-4.8",
                    "label": "Claude Opus 4.8 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4.7",
                    "label": "Claude Opus 4.7 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4.6",
                    "label": "Claude Opus 4.6 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4.5",
                    "label": "Claude Opus 4.5 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-5.5",
                    "label": "GPT-5.5 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-5.4",
                    "label": "GPT-5.4 (Copilot)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {"value": GPT_4_1, "label": "GPT-4.1 (Copilot)", "tier": "flagship"},
                {"value": "gpt-4o", "label": "GPT-4o (Copilot)", "tier": "flagship"},
                {
                    "value": "claude-sonnet-4.6",
                    "label": "Claude Sonnet 4.6 (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-sonnet-4.5",
                    "label": "Claude Sonnet 4.5 (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "o4-mini",
                    "label": "o4-mini (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "o3",
                    "label": "o3 (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "o3-mini",
                    "label": "o3-mini (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "o1",
                    "label": "o1 (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-3.7-sonnet",
                    "label": "Claude 3.7 Sonnet (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": GEMINI_2_5_PRO,
                    "label": "Gemini 2.5 Pro (Copilot)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-haiku-4.5",
                    "label": "Claude Haiku 4.5 (Copilot)",
                    "tier": "fast",
                },
                {
                    "value": "gemini-2.0-flash",
                    "label": "Gemini 2.0 Flash (Copilot)",
                    "tier": "fast",
                },
                {
                    "value": "gpt-4.1-mini",
                    "label": "GPT-4.1 mini (Copilot)",
                    "tier": "fast",
                },
                {
                    "value": "o1-mini",
                    "label": "o1-mini (Copilot)",
                    "tier": "fast",
                    "supportsThinking": True,
                },
                {
                    "value": "gpt-4o-mini",
                    "label": "GPT-4o mini (Copilot)",
                    "tier": "fast",
                },
            ],
        )

        # --- Grok (xAI) ---
        self._providers["grok"] = Provider(
            name="grok",
            label="Grok (xAI)",
            description="Grok models via xAI (Elon Musk)",
            category="special",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "grok-4.3",
                    "label": "Grok 4.3",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "grok-4.20-reasoning",
                    "label": "Grok 4.20 Reasoning",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "grok-4.1-fast",
                    "label": "Grok 4.1 Fast",
                    "tier": "fast",
                    "supportsThinking": True,
                },
                {
                    "value": "grok-4",
                    "label": "Grok 4",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "grok-3",
                    "label": "Grok 3",
                    "tier": "standard",
                    "supportsThinking": True,
                },
            ],
        )

        # --- Gateways: OpenRouter, Hugging Face Inference Providers ---
        # Their live lists come from gateway_providers; these are the
        # registry's defaults, so the phone offers the same first choices.
        from models_registry import list_provider

        for name, label, description in (
            (
                "openrouter",
                "OpenRouter",
                "Hundreds of models from many vendors through one OpenRouter key",
            ),
            (
                "huggingface",
                "Hugging Face",
                "Open models of the Hub through Hugging Face Inference Providers",
            ),
        ):
            self._providers[name] = Provider(
                name=name,
                label=label,
                description=description,
                category="special",
                requires_api_key=True,
                requires_oauth=False,
                requires_cli=False,
                models=[
                    {
                        "value": entry.model_id,
                        "label": entry.label,
                        "tier": entry.tier,
                        "supportsThinking": entry.supports_thinking,
                    }
                    for entry in list_provider(name)
                ],
            )

        # --- Windsurf AI (Codeium) ---
        # Source: docs.windsurf.com/windsurf/models
        self._providers["windsurf"] = Provider(
            name="windsurf",
            label="Windsurf (Codeium)",
            description="Windsurf AI models via Codeium platform - Service key or SSO authentication",
            category="special",
            requires_api_key=True,  # Service key (Personal Access Token)
            requires_oauth=True,  # Also supports SSO/OAuth authentication
            requires_cli=False,
            models=[
                {"value": "swe-1.6", "label": "SWE-1.6", "tier": "flagship"},
                {"value": "swe-1.6-fast", "label": "SWE-1.6 Fast", "tier": "fast"},
                {"value": "swe-1.5", "label": "SWE-1.5", "tier": "flagship"},
                {
                    "value": "swe-1.5-thinking",
                    "label": "SWE-1.5 Thinking",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-sonnet-4",
                    "label": "Claude Sonnet 4 (Windsurf)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-opus-4",
                    "label": "Claude Opus 4 (Windsurf)",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "claude-3.7-sonnet",
                    "label": "Claude 3.7 Sonnet (Windsurf)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {"value": GPT_4_1, "label": "GPT-4.1 (Windsurf)", "tier": "standard"},
                {"value": "gpt-4o", "label": "GPT-4o (Windsurf)", "tier": "standard"},
                {
                    "value": GEMINI_2_5_PRO,
                    "label": "Gemini 2.5 Pro (Windsurf)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "deepseek-r1",
                    "label": "DeepSeek R1 (Windsurf)",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {
                    "value": "deepseek-v3",
                    "label": "DeepSeek V3 (Windsurf)",
                    "tier": "standard",
                },
                {
                    "value": "gemini-2.0-flash",
                    "label": "Gemini 2.0 Flash (Windsurf)",
                    "tier": "fast",
                },
                {"value": "swe-1.5-fast", "label": "SWE-1.5 Fast", "tier": "fast"},
            ],
        )

        # --- Custom/Enterprise ---
        self._providers["custom"] = Provider(
            name="custom",
            label="Custom/Enterprise",
            description="Custom API endpoints",
            category="special",
            requires_api_key=True,
            requires_oauth=False,
            requires_cli=False,
            models=[
                {
                    "value": "custom-model-1",
                    "label": "Custom Model 1",
                    "tier": "flagship",
                    "supportsThinking": True,
                },
                {
                    "value": "custom-model-2",
                    "label": "Custom Model 2",
                    "tier": "standard",
                    "supportsThinking": True,
                },
                {"value": "custom-model-3", "label": "Custom Model 3", "tier": "fast"},
                {
                    "value": "custom",
                    "label": "Autre (saisie libre)",
                    "tier": "local",
                    "supportsThinking": True,
                },
            ],
        )

    def get_all_providers(self) -> list[dict[str, Any]]:
        """Retourne tous les providers au format JSON"""
        return [
            {
                "name": p.name,
                "label": p.label,
                "description": p.description,
                "category": p.category,
                "requiresApiKey": p.requires_api_key,
                "requiresOAuth": p.requires_oauth,
                "requiresCLI": p.requires_cli,
                "models": p.models,
            }
            for p in self._providers.values()
        ]


provider_registry = ProviderRegistry()
