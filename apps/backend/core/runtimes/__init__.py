"""
Runtime Factory: Choix du runtime agent selon ProviderConfig
"""

import sys
from pathlib import Path

from core.runtimes.claude_sdk_runtime import ClaudeSDKRuntime
from core.runtimes.copilot_runtime import CopilotRuntime

# ProviderConfig is imported lazily inside the factory: `src.connectors` lives
# under the project root, which the factory puts on sys.path first.
from core.runtimes.litellm_runtime import LiteLLMRuntime


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
    """
    Factory pour choisir le runtime agent selon ProviderConfig.
    Utilise CopilotRuntime si provider = 'copilot',
    ClaudeSDKRuntime si provider = 'anthropic-sdk', sinon LiteLLMRuntime.
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

    # Copilot CLI runtime
    if cli_provider == "copilot" or (
        hasattr(config, "provider") and config.provider == "copilot"
    ):
        return CopilotRuntime(
            spec_dir, phase, project_dir, agent_type, config, cli_thinking
        )

    if hasattr(config, "is_claude_sdk") and config.is_claude_sdk:
        return ClaudeSDKRuntime(
            spec_dir, phase, project_dir, agent_type, config, cli_thinking
        )
    else:
        return LiteLLMRuntime(
            spec_dir, phase, project_dir, agent_type, config, cli_thinking
        )
