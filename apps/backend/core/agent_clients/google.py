"""`GoogleAgentClient` — Gemini through its OpenAI-compatible endpoint.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

from .openai import (
    OpenAIAgentClient,
)

# =============================================================================
# Google Gemini Agent Client — OpenAI-compatible endpoint
# =============================================================================


class GoogleAgentClient(OpenAIAgentClient):
    """Agent client for Google Gemini via its OpenAI-compatible API.

    Gemini exposes an OpenAI-compatible Chat Completions endpoint
    (https://generativelanguage.googleapis.com/v1beta/openai/), so we reuse the
    proven OpenAI tool-use loop verbatim and only swap three things:
      - the base URL,
      - the API key (GEMINI_API_KEY, falling back to GOOGLE_API_KEY),
      - the default model.

    Gemini's compatibility layer takes `reasoning_effort` on its thinking
    models (`gemini_reasoning_effort` maps the user's level onto it); it has
    no `prompt_cache_key`, which is forced off here.
    """

    def __init__(
        self,
        model: str = "gemini-2.5-pro",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        reasoning_effort: str | None = None,
        prompt_cache_key: str | None = None,  # accepted for parity; unused on Gemini
        spec_dir: str | None = None,
    ):
        import os as _os

        super().__init__(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=project_dir,
            agent_type=agent_type,
            reasoning_effort=reasoning_effort,
            prompt_cache_key=None,
            spec_dir=spec_dir,
        )
        self._api_key = _os.environ.get("GOOGLE_API_KEY", "")
        self._api_base = (
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        )
        self._provider_name = "google"

    def provider_name(self) -> str:
        return "google"
