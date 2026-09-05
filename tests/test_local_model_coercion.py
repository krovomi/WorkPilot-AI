#!/usr/bin/env python3
"""A hosted model id must never reach a local server.

The failure this guards against is not subtle, it is just silent until it is
too late: a task whose provider was switched to Ollama while its saved model
was still `claude-opus-4-5-20251101` ran the whole spec pipeline as
``provider=ollama, model=claude-opus-4-5-20251101``. Every phase asked the local
server for a model it cannot have, every phase fell back to pulling a Claude
manifest from the Ollama registry, and every phase died on
``pull model manifest: file does not exist`` — seven identical failures whose
message named neither the cause nor the fix.

Three layers now refuse it, and each is tested here because each one is reached
by a different caller: the shared resolver (`get_phase_model`, i.e. planning /
coding / QA), the spec runner's own CLI resolution, and the client factory that
every local run funnels through.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from phase_config import (  # noqa: E402
    _resolve_provider_model,
    coerce_local_model,
    is_hosted_only_model,
    is_local_provider,
)

# Ids that only exist behind somebody's API.
HOSTED_ONLY = [
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-opus-4.8",
    "claude-fable-5",
    "gpt-5.5",
    "gpt-4.1",
    "chatgpt-4o-latest",
    "o3",
    "o4-mini",
    "gemini-3.1-pro",
    "models/gemini-2.5-flash",
    "grok-4.3",
    "anthropic.claude-opus-4-7",
    "swe-1.6",
]

# Names a local server can genuinely serve. Several of them belong to families
# that ALSO have a hosted API (Mistral, DeepSeek, Gemma), which is exactly why
# the discriminator has to be narrow: rejecting these would break a model the
# user really has on disk.
LOCAL_OK = [
    "llama3.3",
    "llama3.2",
    "mistral",
    "mistral-large",
    "mistral-large-3",
    "mixtral",
    "deepseek-r1",
    "deepseek-v3.2",
    "deepseek-coder-v2",
    "qwen2.5-coder",
    "qwen3-embedding:8b",
    "gemma3",
    "phi4",
    "codellama",
    "hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF",
]


class TestHostedOnlyDetection:
    @pytest.mark.parametrize("model", HOSTED_ONLY)
    def test_hosted_ids_are_recognised(self, model: str):
        assert is_hosted_only_model(model) is True

    @pytest.mark.parametrize("model", LOCAL_OK)
    def test_local_names_are_left_alone(self, model: str):
        assert is_hosted_only_model(model) is False

    def test_empty_is_not_hosted(self):
        assert is_hosted_only_model("") is False


class TestCoercion:
    @pytest.mark.parametrize("model", HOSTED_ONLY)
    def test_hosted_id_falls_back_to_the_configured_local_model(
        self, model: str, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OLLAMA_MODEL", "qwen2.5-coder")
        assert coerce_local_model(model) == "qwen2.5-coder"

    @pytest.mark.parametrize("model", LOCAL_OK)
    def test_local_name_passes_through_untouched(self, model: str):
        assert coerce_local_model(model) == model

    def test_empty_model_uses_the_configured_default(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OLLAMA_MODEL", "llama3.2")
        assert coerce_local_model("") == "llama3.2"
        assert coerce_local_model(None) == "llama3.2"

    def test_env_wins_over_the_registry_default(self, monkeypatch: pytest.MonkeyPatch):
        """The model picked in Settings reaches the backend as OLLAMA_MODEL.

        It is read live rather than at import time so a choice made after the
        process started still applies.
        """
        monkeypatch.setenv("OLLAMA_MODEL", "gemma3")
        assert coerce_local_model("claude-opus-4-6") == "gemma3"
        monkeypatch.delenv("OLLAMA_MODEL")
        monkeypatch.setenv("LOCAL_LLM_MODEL", "phi4")
        assert coerce_local_model("claude-opus-4-6") == "phi4"


class TestProviderResolution:
    @pytest.mark.parametrize("provider", ["ollama", "local", "lmstudio", "OLLAMA"])
    def test_local_providers_are_recognised(self, provider: str):
        assert is_local_provider(provider) is True

    @pytest.mark.parametrize("provider", ["anthropic", "openai", "copilot", "", None])
    def test_hosted_providers_are_not_local(self, provider):
        assert is_local_provider(provider) is False

    def test_saved_claude_model_does_not_reach_ollama(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The exact case from the bug report."""
        monkeypatch.setenv("OLLAMA_MODEL", "llama3.3")
        resolved = _resolve_provider_model("claude-opus-4-5-20251101", "ollama")
        assert resolved == "llama3.3"

    def test_claude_shorthand_does_not_reach_ollama(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """`sonnet` expands to a full Claude id — the expansion must not escape.

        This is checked before the MODEL_ID_MAP branch precisely because that
        branch would hand Ollama a resolved `claude-sonnet-…` id.
        """
        monkeypatch.setenv("OLLAMA_MODEL", "llama3.3")
        assert _resolve_provider_model("sonnet", "ollama") == "llama3.3"

    def test_a_real_local_model_survives_resolution(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OLLAMA_MODEL", "llama3.3")
        assert _resolve_provider_model("qwen2.5-coder", "ollama") == "qwen2.5-coder"
        assert (
            _resolve_provider_model("hf.co/org/model-GGUF", "ollama")
            == "hf.co/org/model-GGUF"
        )

    def test_anthropic_provider_is_untouched(self):
        """The guard is local-only: Anthropic still resolves its own ids."""
        assert _resolve_provider_model("claude-opus-4.8", "anthropic") == (
            "claude-opus-4-8"
        )


class TestSpecRunnerResolution:
    def test_spec_runner_resolves_the_model_provider_aware(self):
        """The spec phase must use the same resolver as the other three.

        It used to substitute the provider default only when the model was
        still argparse's "sonnet", so any model the frontend passed explicitly
        — which it always does — went through untouched.
        """
        source = (
            REPO_ROOT / "apps" / "backend" / "runners" / "spec_runner.py"
        ).read_text(encoding="utf-8")
        assert "_resolve_provider_model(args.model, args.provider)" in source
        assert 'args.model\n        == "sonnet"' not in source


class TestClientFactoryGuard:
    def test_local_branch_coerces_the_model(self):
        """`create_agent_client` is the choke point every local run passes."""
        source = (REPO_ROOT / "apps" / "backend" / "core" / "client.py").read_text(
            encoding="utf-8"
        )
        assert "resolved_local_model = coerce_local_model(model)" in source
        assert 'resolved_local_model = model or "llama3.3"' not in source


class TestAutoPullGuard:
    def test_a_hosted_id_is_never_pulled_from_the_registry(self):
        """Asking Ollama's registry for a Claude manifest has one outcome.

        The pull-on-demand fallback exists for a library model the user never
        ran `ollama pull` on. For a hosted id it is a round trip that can only
        answer "file does not exist", so it is refused with the real cause.
        """
        source = (
            REPO_ROOT / "apps" / "backend" / "core" / "agent_client.py"
        ).read_text(encoding="utf-8")
        assert "if is_hosted_only_model(self.model):" in source
        # …and the pull that IS legitimate streams its progress instead of
        # freezing the log for the duration of a multi-gigabyte download.
        assert "_pull_ollama_model_stream" in source
        assert 'json={"name": self.model, "stream": True}' in source
