import sys
from pathlib import Path

import pytest

# Add the apps/backend directory to the Python path
backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from core.runtimes import create_agent_runtime


def test_a_provider_other_than_claude_is_refused():
    """Only the Claude SDK runtime exists: another provider goes through
    `create_agent_client`, not a runtime that never applied the agent's tools."""

    class DummyConfig:
        is_claude_sdk = False
        provider = "openai"
        model = "gpt-5"

    with pytest.raises(ValueError, match="'openai'.*create_agent_client"):
        create_agent_runtime(
            spec_dir=None,
            phase="test",
            project_dir=None,
            agent_type="test",
            config=DummyConfig(),
        )


def test_runtime_factory_claude():
    """Claude SDK runtime is now a real runtime (not NotImplementedError)."""
    from core.runtimes.claude_sdk_runtime import ClaudeSDKRuntime

    class DummyConfig:
        is_claude_sdk = True

    # The factory now returns a ClaudeSDKRuntime instead of raising NotImplementedError
    runtime = create_agent_runtime(
        spec_dir=None,
        phase="test",
        project_dir=None,
        agent_type="test",
        cli_provider=None,
        cli_model=None,
        cli_thinking=None,
        config=DummyConfig(),
    )
    assert runtime is not None
    assert isinstance(runtime, ClaudeSDKRuntime)


def test_the_factory_finds_the_provider_config_off_the_backend_path(
    tmp_path, monkeypatch
):
    """Started from apps/backend (a runner), the repository root is not on
    sys.path; the factory adds it to read `src.connectors.llm_config`."""
    import core.runtimes.claude_sdk_runtime as sdk_runtime

    import src.connectors.llm_config as llm_config

    root = Path(__file__).resolve().parents[1]
    monkeypatch.setattr(llm_config, "CONFIG_FILE", tmp_path / "providers.json")
    monkeypatch.setattr(sdk_runtime, "create_simple_client", lambda **_: object())
    monkeypatch.setattr(
        sys, "path", [p for p in sys.path if Path(p or ".").resolve() != root]
    )

    runtime = create_agent_runtime(
        spec_dir=None,
        phase="insight_extraction",
        project_dir=None,
        agent_type="insight_extractor",
        cli_provider="claude",
    )

    assert isinstance(runtime, sdk_runtime.ClaudeSDKRuntime)
    assert str(root) in sys.path
