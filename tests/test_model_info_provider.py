"""Tests for provider resolution in core.model_info used for log labelling.

Regression: GitHub Copilot authenticates with an Anthropic-compatible token, so
the API-key heuristic mislabelled it as the "anthropic" provider in the logs
(`[anthropic:Opus 4.6]`) while the frontend correctly showed `[copilot:...]`.
The explicit `SELECTED_LLM_PROVIDER` / `AUTO_CLAUDE_PROVIDER` env signal must win.
"""

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest
from core import model_info

import src.connectors.llm_config as llm_config


def test_selected_llm_provider_wins_over_anthropic_token(monkeypatch):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

    assert model_info._detect_provider_from_env() == "copilot"


def test_claude_alias_normalised_to_anthropic(monkeypatch):
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)

    assert model_info._detect_provider_from_env() == "anthropic"


def test_auto_claude_provider_used_as_fallback(monkeypatch):
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "openai")

    assert model_info._detect_provider_from_env() == "openai"


def test_anthropic_token_still_detected_without_explicit_signal(monkeypatch):
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    assert model_info._detect_provider_from_env() == "anthropic"


def test_get_current_model_info_prefers_explicit_provider(monkeypatch):
    # Simulate the agent subprocess where the IPC global is not set.
    fake_provider_api = types.ModuleType("provider_api")
    fake_provider_api.get_selected_provider = lambda: None
    monkeypatch.setitem(sys.modules, "provider_api", fake_provider_api)

    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "copilot")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    info = model_info.get_current_model_info()

    assert info["provider"] == "copilot"
    assert info["model_label"] == "GitHub Copilot"


# --- What the log lines say, provider by provider -------------------------


_spec = importlib.util.spec_from_file_location(
    "model_info_gh_fake", Path(__file__).resolve().parent / "gh_fake.py"
)
_gh_fake = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _gh_fake
_spec.loader.exec_module(_gh_fake)

PROVIDER_ENV = (
    "SELECTED_LLM_PROVIDER",
    "AUTO_CLAUDE_PROVIDER",
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GROK_API_KEY",
    "OLLAMA_BASE_URL",
    "WINDSURF_API_KEY",
    "WINDSURF_OAUTH_TOKEN",
    "CODEIUM_API_KEY",
    "ANTHROPIC_MODEL",
    "OPENAI_MODEL",
    "GOOGLE_MODEL",
    "GROK_MODEL",
    "OLLAMA_MODEL",
    "WINDSURF_MODEL",
)


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """No provider in the environment, no saved config, a `gh` with no login."""
    for name in PROVIDER_ENV:
        monkeypatch.delenv(name, raising=False)
    saved = tmp_path / "providers.json"
    monkeypatch.setattr(llm_config, "CONFIG_FILE", saved)
    gh = _gh_fake.write_fake_gh(
        tmp_path / "bin",
        {
            "auth status": {
                "stderr": "You are not logged into any GitHub hosts.",
                "code": 1,
            }
        },
    )
    monkeypatch.setenv("PATH", str(gh.directory))

    def save(configs: dict) -> None:
        saved.write_text(json.dumps(configs), encoding="utf-8")

    return save, gh


@pytest.mark.parametrize(
    ("variable", "provider"),
    [
        ("CLAUDE_CODE_OAUTH_TOKEN", "anthropic"),
        ("OPENAI_API_KEY", "openai"),
        ("GOOGLE_API_KEY", "google"),
        ("GROK_API_KEY", "grok"),
        ("OLLAMA_BASE_URL", "ollama"),
        ("CODEIUM_API_KEY", "windsurf"),
    ],
)
def test_the_provider_is_read_from_its_credential(
    machine, monkeypatch, variable, provider
):
    monkeypatch.setenv(variable, "test-0000")  # pragma: allowlist secret

    assert model_info._detect_provider_from_env() == provider


def test_a_gh_logged_in_means_copilot(machine):
    _, gh = machine
    gh.answer({"auth status": {"stdout": "✓ Logged in to github.com account dana"}})

    assert model_info._detect_provider_from_env() == "copilot"
    assert gh.calls() == [["auth", "status"]]


def test_nothing_configured_reads_as_unknown(machine):
    assert model_info.get_current_model_info() == {
        "provider": "unknown",
        "model": "unknown",
        "model_label": "unknown",
    }


def test_without_gh_there_is_no_copilot(machine, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))

    assert model_info._is_copilot_available() is False


def test_the_provider_chosen_in_the_ui_wins(machine, monkeypatch):
    import provider_selection

    monkeypatch.setenv("OPENAI_API_KEY", "test-0000")  # pragma: allowlist secret
    monkeypatch.setattr(provider_selection, "_selected_provider", "windsurf")
    monkeypatch.setenv("WINDSURF_MODEL", "swe-1.6")

    assert model_info.get_model_info_for_logs() == {
        "provider": "windsurf",
        "model_label": "SWE-1.6",
    }


@pytest.mark.parametrize(
    ("provider", "label"),
    [
        ("anthropic", "Claude Opus 4.8"),
        ("openai", "GPT-4o"),
        ("google", "Gemini 3.0"),
        ("grok", "Grok 2"),
        ("ollama", "Ollama: llama3"),
        ("windsurf", "Claude Sonnet 4 (Windsurf)"),
        ("copilot", "GitHub Copilot"),
        ("mistral", "Unknown Model"),
    ],
)
def test_each_provider_has_a_default_model(machine, provider, label):
    assert model_info._get_model_info_for_provider(provider)["model_label"] == label


@pytest.mark.parametrize(
    ("provider", "model", "label"),
    [
        ("anthropic", "claude-fable-5", "Claude Fable 5"),
        ("anthropic", "claude-next", "Claude: claude-next"),
        ("openai", "gpt-9", "OpenAI: gpt-9"),
        ("google", "gemini-9", "Gemini: gemini-9"),
        ("grok", "grok-9", "Grok: grok-9"),
        ("ollama", "qwen3", "Ollama: qwen3"),
        ("windsurf", "swe-9", "Windsurf: swe-9"),
    ],
)
def test_the_model_set_in_the_environment_is_named(
    machine, monkeypatch, provider, model, label
):
    monkeypatch.setenv(f"{provider.upper()}_MODEL", model)

    info = model_info._get_model_info_for_provider(provider)

    assert info == {"model": model, "model_label": label}


def test_a_saved_model_wins_over_the_environment(machine, monkeypatch):
    save, _ = machine
    save({"claude": {"model": "claude-sonnet-5"}, "openai": {"api_key": "x"}})
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-opus-4-6")
    monkeypatch.setenv("OPENAI_MODEL", "o3")

    assert model_info._get_model_info_for_provider("anthropic")["model_label"] == (
        "Claude Sonnet 5"
    )
    # A saved entry without a model leaves the environment's.
    assert model_info._get_model_info_for_provider("openai")["model"] == "o3"


def test_without_the_config_module_the_environment_is_used(machine, monkeypatch):
    monkeypatch.setitem(sys.modules, "src.connectors.llm_config", None)
    monkeypatch.setenv("GROK_MODEL", "grok-1")

    assert model_info._get_model_info_for_provider("grok")["model_label"] == "Grok 1"


def test_a_failure_reads_as_error_rather_than_breaking_the_log_line(
    machine, monkeypatch
):
    def broken(provider):
        raise OSError("config unreadable")

    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
    monkeypatch.setattr(model_info, "_get_model_info_for_provider", broken)

    assert model_info.get_current_model_info()["provider"] == "error"
