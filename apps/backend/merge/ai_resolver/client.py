"""
AI Resolver Client
==================

The model the resolver asks is the one the user chose.

The question goes through the one-shot completion of the agent runtime port
(core imports merge, so merge cannot import core back). That routes it to the
user's provider and a model of that provider, so a project on Copilot, OpenAI,
a local model or any other provider merges without a Claude token.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from .resolver import AIResolver

logger = logging.getLogger(__name__)


def create_ai_resolver(project_dir: Path | str | None = None) -> AIResolver:
    """An ``AIResolver`` that asks the user's provider, or none without a runtime."""
    import agent_runtime

    runtime = agent_runtime.current()
    if runtime is None:
        logger.warning("No agent runtime installed, AI resolution unavailable")
        return AIResolver()

    context = {"project_dir": str(project_dir)} if project_dir else {}

    def ask(system: str, user: str) -> str:
        # An empty answer is not code: the resolver sends the conflict to review.
        try:
            return asyncio.run(
                runtime.oneshot_completion(user, system_prompt=system, **context)
            )
        except Exception as e:  # the provider's own failures, whatever they are
            logger.error(f"AI merge call failed: {e}")
            return ""

    return AIResolver(ai_call_fn=ask)
