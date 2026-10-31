"""Which client `_build_agent_client` builds per provider, pinned before its split.

`_build_agent_client` is one function of more than five hundred lines: the
provider resolution, the offline route, then one `elif` branch per provider,
each building its own prompt and client. These tests replace every client
class with a recorder and read which class each provider got and with which
arguments. They were written green against the function before its split,
and the split keeps them green.

Fake credentials are assembled at runtime: a literal shaped like a key is
what the pre-commit secret scan looks for.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

_FAKE = "test-" + "0" * 24


class _Recorder:
    """Stands for one client class; keeps every construction."""

    def __init__(self, name: str, built: list) -> None:
        self.name = name
        self.built = built

    def __call__(self, *args, **kwargs):
        client = types.SimpleNamespace(
            kind=self.name,
            args=args,
            kwargs=kwargs,
            tools=["read"],
            trust_state=lambda: "trusted",
        )
        self.built.append(client)
        return client


_CLASSES = (
    "ClaudeAgentClient",
    "CopilotAgentClient",
    "WindsurfAgentClient",
    "OpenAIAgentClient",
    "GoogleAgentClient",
    "LocalAgentClient",
    "CompatibleProviderAgentClient",
    "PiCliAgentClient",
    "OpenCodeCliAgentClient",
    "AntigravityCliAgentClient",
)


@pytest.fixture
def harness(tmp_path: Path, monkeypatch):
    client = importlib.import_module("core.client")
    agent_client = importlib.import_module("core.agent_client")
    codex = importlib.import_module("core.codex_cli_client")
    llm = importlib.import_module("core.llm_optimization")
    offline = importlib.import_module("offline_policy")
    phase_config = importlib.import_module("phase_config")
    context_mgmt = importlib.import_module("context_mgmt")
    windows = importlib.import_module("context_mgmt.windows")
    catalog = importlib.import_module("provider_models_catalog")

    state = types.SimpleNamespace(
        project_dir=tmp_path / "project",
        spec_dir=tmp_path / "project" / ".workpilot" / "specs" / "001",
        built=[],
        sdk_calls=[],
        switches=[],
        degradations=[],
        pi_traces=[],
        offline=None,  # (provider, model, base_url) the offline route returns
        codex_cli=False,
        api_key_only=False,
        api_keys={},
        provider_config={},
        degrades_to="claude",
        # The budget of the "high" level, which the CLIs read back by name.
        effort=phase_config.get_thinking_budget("high"),
    )
    state.spec_dir.mkdir(parents=True)

    for name in _CLASSES:
        monkeypatch.setattr(agent_client, name, _Recorder(name, state.built))
    monkeypatch.setattr(
        codex, "CodexCliAgentClient", _Recorder("CodexCli", state.built)
    )
    monkeypatch.setattr(codex, "openai_uses_codex_cli", lambda: state.codex_cli)
    monkeypatch.setattr(
        codex, "openai_model_uses_api_key", lambda _model: state.api_key_only
    )

    def create_client(**kwargs):
        state.sdk_calls.append(kwargs)
        return "sdk-client"

    def offline_route(_project, _spec, _task, provider, model, *, chosen):
        state.route_chosen = chosen
        return state.offline or (provider, model, None)

    def prompt(_project, tool_use_hint=False, project_instructions=False):
        # The WorkPilot-loop clients (hint on) are the ones given AGENTS.md.
        assert project_instructions == tool_use_hint
        return f"BASE(hint={tool_use_hint})"

    patches = {
        client: {
            "create_client": create_client,
            "_effort_for": lambda _spec, _type: state.effort,
            "_resolve_active_provider": lambda _spec: ("claude", False),
            "_log_llm_context_switch": lambda *a: state.switches.append(a),
            "_log_provider_degradation": lambda *a: state.degradations.append(a),
            "_trace_pi_trust": lambda *a: state.pi_traces.append(a),
            "_inject_domain_addendum": lambda base, agent, _spec: f"{base}+{agent}",
            "_get_cached_project_data": lambda _dir: ({}, {}),
            "load_project_mcp_config": lambda _dir: {},
            "get_allowed_tools": lambda *a, **k: ["Read", "Edit"],
            "get_provider_capabilities": lambda _p: types.SimpleNamespace(
                degrades_to=state.degrades_to
            ),
        },
        llm: {
            "build_base_system_prompt": prompt,
            "openai_reasoning_effort": lambda model, budget: f"oa:{model}:{budget}",
            "openai_prompt_cache_key": lambda _spec, agent: f"key:{agent}",
            "gemini_reasoning_effort": lambda model, budget: f"gm:{model}:{budget}",
            "compatible_effort_params": lambda provider, model, budget: {
                "effort": f"cp:{provider}:{model}:{budget}"
            },
        },
        offline: {
            "resolve_offline_route": offline_route,
            "local_endpoint": lambda provider: f"http://127.0.0.1/{provider}",
        },
        phase_config: {
            "coerce_local_model": lambda model: f"local:{model}",
            "is_hosted_only_model": lambda model: model.startswith("claude"),
            "normalize_anthropic_model_id": lambda model: model.replace(".", "-"),
        },
        context_mgmt: {"codex_auto_compact_limit": lambda *_a: 123456},
        windows: {"resolve_context_window": lambda _model: 200000},
        catalog: {"_api_key_for": lambda provider: state.api_keys.get(provider)},
    }
    for module, values in patches.items():
        for name, value in values.items():
            monkeypatch.setattr(module, name, value)

    llm_config = types.ModuleType("src.connectors.llm_config")
    llm_config.load_provider_config = lambda name: state.provider_config.get(name)
    monkeypatch.setitem(sys.modules, "src.connectors.llm_config", llm_config)
    for name in ("MISTRAL_BASE_URL", "DEEPSEEK_BASE_URL", "GROK_BASE_URL"):
        monkeypatch.delenv(name, raising=False)

    def build(provider=None, model="model-x", agent_type="coder", **kwargs):
        result = client._build_agent_client(
            state.project_dir,
            state.spec_dir,
            model,
            agent_type=agent_type,
            provider=provider,
            **kwargs,
        )
        return result

    state.build = build
    return state


def _only(harness):
    assert len(harness.built) == 1, [c.kind for c in harness.built]
    return harness.built[0]


# -- Before the branch ---------------------------------------------------------


def test_the_users_effort_applies_unless_the_caller_states_one(harness):
    harness.build("copilot")
    assert harness.built[-1].kwargs["thinking_budget"] == harness.effort

    harness.build("copilot", max_thinking_tokens=None)
    assert harness.built[-1].kwargs["thinking_budget"] is None


def test_a_provider_named_by_the_caller_counts_as_chosen(harness):
    harness.build("Claude")
    assert harness.route_chosen is True

    harness.build(None)
    assert harness.route_chosen is False


def test_a_dotted_claude_model_id_is_rewritten(harness):
    harness.build("claude", model="claude-opus-4.8")

    assert harness.sdk_calls[0]["model"] == "claude-opus-4-8"
    assert harness.switches[0][1:3] == ("claude", "claude-opus-4-8")


def test_the_offline_route_can_overrule_the_provider(harness):
    harness.offline = ("ollama", "qwen-local", "http://127.0.0.1:11434")

    harness.build("openai", model="gpt-5")

    built = _only(harness)
    assert built.kind == "LocalAgentClient"
    assert built.kwargs["model"] == "qwen-local"  # not coerced: the route chose it
    assert built.kwargs["base_url"] == "http://127.0.0.1:11434"
    assert built.kwargs["offline_only"] is True


# -- One branch per provider ---------------------------------------------------


def test_claude_wraps_the_sdk_client(harness):
    result = harness.build(
        "claude",
        agents={"a": {}},
        resume="sess",
        output_format={"type": "json_schema"},
        use_subagents=False,
        roster="qa",
    )

    assert result.kind == "ClaudeAgentClient"
    assert result.args == ("sdk-client",)
    call = harness.sdk_calls[0]
    assert call["agents"] == {"a": {}}
    assert call["resume"] == "sess"
    assert call["output_format"] == {"type": "json_schema"}
    assert call["use_subagents"] is False
    assert call["roster"] == "qa"
    assert call["max_thinking_tokens"] == harness.effort


def test_copilot(harness):
    built = harness.build("copilot")

    assert built.kind == "CopilotAgentClient"
    assert built.kwargs == {
        "model": "model-x",
        "system_prompt": "BASE(hint=False)+coder",
        "allowed_tools": ["Read", "Edit"],
        "cwd": str(harness.project_dir.resolve()),
        "agent_type": "coder",
        "spec_dir": str(harness.spec_dir),
        "thinking_budget": harness.effort,
    }


def test_windsurf(harness):
    built = harness.build("windsurf")

    assert built.kind == "WindsurfAgentClient"
    assert built.kwargs == {
        "model": "model-x",
        "system_prompt": "BASE(hint=True)+coder",
        "max_turns": 50,
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "spec_dir": str(harness.spec_dir),
    }


def test_openai_over_the_api(harness):
    built = harness.build("openai", model="")

    assert built.kind == "OpenAIAgentClient"
    assert built.kwargs == {
        "model": "gpt-4o",
        "system_prompt": "BASE(hint=True)+coder",
        "max_turns": 50,
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "reasoning_effort": f"oa:gpt-4o:{harness.effort}",
        "prompt_cache_key": "key:coder",
        "spec_dir": str(harness.spec_dir),
    }


def test_openai_through_the_codex_cli(harness):
    harness.codex_cli = True

    built = harness.build("openai", model="gpt-5-codex", resume="thread-1")

    assert built.kind == "CodexCli"
    assert built.kwargs == {
        "model": "gpt-5-codex",
        "system_prompt": "BASE(hint=True)+coder",
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "reasoning_effort": f"oa:gpt-5-codex:{harness.effort}",
        "thread_id": "thread-1",
        "auto_compact_token_limit": 123456,
    }


def test_an_api_only_model_skips_the_codex_cli(harness):
    harness.codex_cli = True
    harness.api_key_only = True

    assert harness.build("openai", model="gpt-image").kind == "OpenAIAgentClient"


@pytest.mark.parametrize("provider", ["google", "gemini"])
def test_google_and_gemini(harness, provider):
    built = harness.build(provider, model="")

    assert built.kind == "GoogleAgentClient"
    assert built.kwargs == {
        "model": "gemini-2.5-pro",
        "system_prompt": "BASE(hint=True)+coder",
        "max_turns": 50,
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "reasoning_effort": f"gm:gemini-2.5-pro:{harness.effort}",
        "spec_dir": str(harness.spec_dir),
    }


@pytest.mark.parametrize(
    ("provider", "base_url", "api_format"),
    [
        ("ollama", None, "ollama"),
        ("local", None, "ollama"),
        ("lmstudio", "http://127.0.0.1/lmstudio", "openai"),
        ("lm-studio", "http://127.0.0.1/lm-studio", "openai"),
        ("llama-cpp", "http://127.0.0.1/llama-cpp", "openai"),
    ],
)
def test_local_servers(harness, provider, base_url, api_format):
    built = harness.build(provider, model="qwen")

    assert built.kind == "LocalAgentClient"
    assert built.kwargs == {
        "model": "local:qwen",
        "base_url": base_url,
        "api_format": api_format,
        "offline_only": False,
        "system_prompt": "BASE(hint=True)+coder",
        "max_turns": 50,
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "spec_dir": str(harness.spec_dir),
        # Sent as Ollama's `think` when the model says it thinks.
        "thinking_level": "high",
    }


def test_a_hosted_model_on_a_local_server_is_replaced_and_said(harness, capsys):
    built = harness.build("ollama", model="claude-sonnet")

    assert built.kwargs["model"] == "local:claude-sonnet"
    assert "n'est pas un modèle local" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("provider", "default_url"),
    [
        ("mistral", "https://api.mistral.ai"),
        ("deepseek", "https://api.deepseek.com"),
        ("grok", "https://api.x.ai"),
    ],
)
def test_compatible_providers(harness, provider, default_url):
    harness.api_keys[provider] = _FAKE

    built = harness.build(provider)

    assert built.kind == "CompatibleProviderAgentClient"
    assert built.kwargs == {
        "provider": provider,
        "model": "model-x",
        "api_key": _FAKE,
        "base_url": default_url,
        # Each provider's own effort scale (`compatible_effort_params`).
        "effort_params": {"effort": f"cp:{provider}:model-x:16384"},
        "system_prompt": "BASE(hint=True)+coder",
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "spec_dir": str(harness.spec_dir),
    }


def test_a_compatible_providers_url_env_wins_over_its_config(harness, monkeypatch):
    harness.api_keys["mistral"] = _FAKE
    harness.provider_config["mistral"] = {"base_url": "https://config.example.test"}
    assert harness.build("mistral").kwargs["base_url"] == "https://config.example.test"

    monkeypatch.setenv("MISTRAL_BASE_URL", "https://env.example.test")
    assert harness.build("mistral").kwargs["base_url"] == "https://env.example.test"


def test_a_compatible_provider_without_a_key_is_refused(harness):
    with pytest.raises(ValueError, match="No API key configured for deepseek"):
        harness.build("deepseek")


def test_pi(harness):
    built = harness.build("pi", model="", resume="s1")

    assert built.kind == "PiCliAgentClient"
    assert built.kwargs == {
        "model": None,
        "system_prompt": "BASE(hint=False)+coder",
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "session_id": "s1",
        "thinking_level": "high",
        "spec_dir": harness.spec_dir,
    }
    assert harness.pi_traces == []


def test_pi_without_a_trust_decision_is_traced(harness, monkeypatch):
    import core.agent_client as agent_client

    original = agent_client.PiCliAgentClient

    def undecided(**kwargs):
        built = original(**kwargs)
        built.trust_state = lambda: "undecided"
        return built

    monkeypatch.setattr(agent_client, "PiCliAgentClient", undecided)
    harness.build("pi")

    assert harness.pi_traces == [(harness.spec_dir, "undecided")]


def test_opencode(harness):
    built = harness.build("opencode", resume="s2")

    assert built.kind == "OpenCodeCliAgentClient"
    assert built.kwargs == {
        "model": "model-x",
        "system_prompt": "BASE(hint=False)+coder",
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "session_id": "s2",
    }


def test_antigravity(harness):
    built = harness.build("antigravity", resume="c3")

    assert built.kind == "AntigravityCliAgentClient"
    assert built.kwargs == {
        "model": "model-x",
        "system_prompt": "BASE(hint=False)+coder",
        "project_dir": str(harness.project_dir),
        "agent_type": "coder",
        "thinking_level": "high",
        "conversation_id": "c3",
    }


@pytest.mark.parametrize(
    "provider", ["copilot", "windsurf", "openai", "google", "gemini", "ollama"]
)
def test_a_callers_prompt_replaces_the_default(harness, provider):
    built = harness.build(provider, system_prompt="MY PROMPT")

    assert built.kwargs["system_prompt"] == "MY PROMPT"


@pytest.mark.parametrize("provider", ["pi", "opencode", "antigravity", "mistral"])
def test_a_callers_prompt_replaces_the_default_on_the_others(harness, provider):
    harness.api_keys["mistral"] = _FAKE

    built = harness.build(provider, system_prompt="MY PROMPT")

    assert built.kwargs["system_prompt"] == "MY PROMPT"


def test_a_provider_without_an_adapter_degrades_to_the_sdk(harness):
    harness.degrades_to = "claude"

    result = harness.build("meta", agents={"a": {}}, resume="r", roster="qa")

    assert result.kind == "ClaudeAgentClient"
    assert harness.degradations == [(harness.spec_dir, "meta", "claude")]
    call = harness.sdk_calls[0]
    assert call["agents"] is None
    assert call["resume"] == "r"
    assert "roster" not in call
    assert "use_subagents" not in call
