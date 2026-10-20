"""`CompatibleProviderAgentClient` — any provider speaking the OpenAI API.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

from .openai import (
    OpenAIAgentClient,
)


class CompatibleProviderAgentClient(OpenAIAgentClient):
    """Agent client for providers exposing OpenAI-compatible chat completions."""

    def __init__(
        self,
        *,
        provider: str,
        model: str,
        api_key: str,
        base_url: str,
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        spec_dir: str | None = None,
    ):
        endpoint = base_url.rstrip("/")
        if not endpoint.endswith("/chat/completions"):
            endpoint += (
                "/v1/chat/completions"
                if not endpoint.endswith("/v1")
                else "/chat/completions"
            )
        super().__init__(
            model=model,
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=project_dir,
            agent_type=agent_type,
            spec_dir=spec_dir,
            api_key=api_key,
            api_base=endpoint,
            provider=provider,
        )
