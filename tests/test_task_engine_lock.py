#!/usr/bin/env python3
"""
A task that owns its engine (`engineLocked` in task_metadata.json)
==================================================================

The provider, model and effort of a locked task were chosen for that task, at
creation or on a resume. Nothing global — the app's default provider arriving
as SELECTED_LLM_PROVIDER, a leftover RESUME_WITH_PROVIDER marker — may replace
them. Unlocked (legacy) tasks keep the old resolution order unchanged.
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

if "claude_agent_sdk" not in sys.modules:
    _mock_sdk = MagicMock()
    _mock_sdk.ClaudeSDKClient = MagicMock()
    _mock_sdk.ClaudeAgentOptions = MagicMock()
    _mock_sdk.AgentDefinition = MagicMock()
    _mock_sdk.types = MagicMock()
    _mock_sdk.types.HookMatcher = MagicMock()
    sys.modules["claude_agent_sdk"] = _mock_sdk
    sys.modules["claude_agent_sdk.types"] = _mock_sdk.types

from core.agent_client import ClaudeAgentClient
from core.client import (
    RESUME_WITH_PROVIDER_FILE,
    _normalize_provider_name,
    _resolve_active_provider,
)
from phase_config import get_phase_model, get_phase_provider, is_engine_locked


def _write_metadata(spec_dir: Path, **fields) -> None:
    (spec_dir / "task_metadata.json").write_text(json.dumps(fields), encoding="utf-8")


def _locked(spec_dir: Path, **overrides) -> None:
    fields = {
        "engineLocked": True,
        "provider": "openai",
        "model": "gpt-5",
        "thinkingLevel": "medium",
        "phaseProviders": {
            "spec": "openai",
            "planning": "openai",
            "coding": "ollama",
            "qa": "anthropic",
        },
        "phaseModels": {
            "spec": "gpt-5",
            "planning": "gpt-5",
            "coding": "qwen3-coder:30b",
            "qa": "claude-sonnet-4-6",
        },
        "phaseThinking": {
            "spec": "medium",
            "planning": "high",
            "coding": "low",
            "qa": "medium",
        },
    }
    fields.update(overrides)
    _write_metadata(spec_dir, **fields)


class TestResolveActiveProvider:
    def test_locked_task_beats_the_default_provider(self, tmp_path, monkeypatch):
        _locked(tmp_path)
        monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
        assert _resolve_active_provider(tmp_path) == ("openai", True)

    def test_locked_task_beats_and_removes_a_leftover_marker(self, tmp_path):
        _locked(tmp_path)
        marker = tmp_path / RESUME_WITH_PROVIDER_FILE
        marker.write_text(json.dumps({"provider": "copilot"}), encoding="utf-8")
        assert _resolve_active_provider(tmp_path) == ("openai", True)
        assert not marker.exists()

    def test_peek_leaves_the_marker_in_place(self, tmp_path):
        _locked(tmp_path)
        marker = tmp_path / RESUME_WITH_PROVIDER_FILE
        marker.write_text("copilot", encoding="utf-8")
        assert _resolve_active_provider(tmp_path, consume=False)[0] == "openai"
        assert marker.exists()

    def test_locked_anthropic_maps_to_claude(self, tmp_path, monkeypatch):
        _locked(tmp_path, provider="anthropic")
        monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
        assert _resolve_active_provider(tmp_path)[0] == "claude"

    def test_unlocked_task_keeps_the_old_order(self, tmp_path, monkeypatch):
        _write_metadata(tmp_path, provider="openai")
        monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
        assert _resolve_active_provider(tmp_path)[0] == "copilot"


class TestPhaseConfig:
    def test_engine_lock_is_read(self, tmp_path):
        assert not is_engine_locked(tmp_path)
        _locked(tmp_path)
        assert is_engine_locked(tmp_path)

    def test_locked_task_reads_its_phase_provider(self, tmp_path):
        _locked(tmp_path)
        assert get_phase_provider(tmp_path, phase="coding") == "ollama"
        assert get_phase_provider(tmp_path, phase="qa") == "anthropic"

    def test_locked_task_reads_phase_models_without_auto_profile(self, tmp_path):
        _locked(tmp_path, isAutoProfile=False)
        assert get_phase_model(tmp_path, "coding") == "qwen3-coder:30b"

    def test_locked_task_missing_a_phase_falls_back_to_its_own_model(self, tmp_path):
        _locked(
            tmp_path,
            phaseModels={"spec": "gpt-5"},
            phaseProviders={},
            provider="openai",
            model="gpt-5-mini",
        )
        assert get_phase_model(tmp_path, "coding") == "gpt-5-mini"

    def test_unlocked_non_auto_task_ignores_phase_models(self, tmp_path):
        _write_metadata(
            tmp_path,
            provider="openai",
            model="gpt-5-mini",
            phaseModels={"coding": "gpt-5"},
        )
        assert get_phase_model(tmp_path, "coding") == "gpt-5-mini"


class TestCreateAgentClientNormalisation:
    def test_normalize_provider_name(self):
        assert _normalize_provider_name("Anthropic") == "claude"
        assert _normalize_provider_name(" claude ") == "claude"
        assert _normalize_provider_name("gemini") == "gemini"
        assert _normalize_provider_name("OpenAI") == "openai"

    @patch("core.client._log_provider_degradation")
    @patch("core.client.create_client")
    def test_explicit_anthropic_is_the_claude_branch(
        self, mock_create_client, mock_degradation, tmp_path
    ):
        from core.client import create_agent_client

        mock_create_client.return_value = MagicMock()
        client = create_agent_client(
            project_dir=tmp_path,
            spec_dir=tmp_path,
            model="claude-sonnet-4-6",
            agent_type="qa_reviewer",
            provider="anthropic",
        )
        assert isinstance(client, ClaudeAgentClient)
        mock_degradation.assert_not_called()
