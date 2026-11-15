"""The runtime of a one-shot agent session (``agent_runtime.create_agent_runtime``).

Its one caller is the insight extractor, which always asks for Claude
(`analysis/insight_extractor.EXTRACTION_PROVIDER`). The Copilot and LiteLLM
runtimes it could also return were never reached and are gone; a session on
another provider goes through `core.client.create_agent_client`, which applies
the agent's declared tools on every provider.
"""

import sys
from pathlib import Path

from core.runtimes.claude_sdk_runtime import ClaudeSDKRuntime


def create_agent_runtime(
    spec_dir,
    phase,
    project_dir,
    agent_type,
    cli_provider=None,
    cli_model=None,
    cli_thinking=None,
    config=None,
):
    """The Claude Agent SDK runtime for this phase's provider configuration.

    Raises:
        ValueError: if the configuration names a provider other than Claude.
    """
    if config is None:
        # Lazy import: the project root may not be on sys.path yet.
        project_root = Path(__file__).parent.parent.parent.parent.parent
        if str(project_root) not in sys.path:
            sys.path.insert(0, str(project_root))
        from src.connectors.llm_config import ProviderConfig

        config = ProviderConfig.load_provider_config(
            phase, spec_dir, cli_provider, cli_model
        )

    if not getattr(config, "is_claude_sdk", False):
        provider = getattr(config, "provider", cli_provider)
        raise ValueError(
            f"No agent runtime for provider {provider!r}: use create_agent_client"
        )
    return ClaudeSDKRuntime(
        spec_dir, phase, project_dir, agent_type, config, cli_thinking
    )
