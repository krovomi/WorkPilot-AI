"""What each provider receives for the effort a Kanban task asks for.

`core/effort_plan.py` is read by the clients, the task feed and the picker: a
level the model never sees must be said, never traced as applied. The values
come from each provider's documentation, read 2026-10-26:

- xAI, docs.x.ai "Reasoning": grok-4.5+ low|medium|high, xhigh from 4.6, no
  "off"; `reasoning_effort` on grok-4.20-multi-agent is an agent count.
- DeepSeek, api-docs.deepseek.com "Thinking Mode": low|high|max, and
  `thinking: {"type": "disabled"}` to stop thinking.
- Mistral, docs.mistral.ai "Reasoning": "high" or "none".
- Ollama: `think` true|false, or low|medium|high on gpt-oss.
"""

from __future__ import annotations

import pytest
from core.effort_plan import (
    LEVELS,
    describe_effort,
    effort_plan,
    effort_trace_label,
)
from core.llm_optimization import (
    compatible_effort_params,
    deepseek_effort_params,
    effort_was_rejected,
    grok_reasoning_effort,
    mistral_reasoning_effort,
)
from phase_config import THINKING_BUDGET_MAP


def _budget(level: str) -> int | None:
    return THINKING_BUDGET_MAP[level]


class TestGrok:
    @pytest.mark.parametrize(
        ("level", "expected"),
        [
            ("none", "low"),  # reasoning cannot be turned off
            ("low", "low"),
            ("medium", "medium"),
            ("high", "high"),
            ("ultrathink", "xhigh"),
        ],
    )
    def test_grok_4_7_takes_every_level(self, level, expected):
        assert grok_reasoning_effort("grok-4.7", _budget(level)) == expected

    def test_xhigh_starts_at_4_6(self):
        assert grok_reasoning_effort("grok-4.5", _budget("ultrathink")) == "high"
        assert grok_reasoning_effort("grok-4.6", _budget("ultrathink")) == "xhigh"

    @pytest.mark.parametrize(
        "model",
        [
            "grok-4.3",
            "grok-4.20-reasoning",
            "grok-4.20-multi-agent",  # the field is an agent count there
            "grok-4-fast-non-reasoning",
            "grok-build-0.1",
            "grok-code-fast-1",
        ],
    )
    def test_models_without_the_setting_get_nothing(self, model):
        assert grok_reasoning_effort(model, _budget("high")) is None

    def test_grok_3_mini_has_two_steps(self):
        assert grok_reasoning_effort("grok-3-mini", _budget("low")) == "low"
        assert grok_reasoning_effort("grok-3-mini", _budget("medium")) == "high"


class TestDeepSeek:
    @pytest.mark.parametrize(
        ("level", "expected"),
        [
            ("none", {"thinking": {"type": "disabled"}}),
            ("low", {"reasoning_effort": "low"}),
            ("medium", {"reasoning_effort": "high"}),
            ("high", {"reasoning_effort": "high"}),
            ("ultrathink", {"reasoning_effort": "max"}),
        ],
    )
    def test_each_level(self, level, expected):
        for model in ("deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"):
            assert deepseek_effort_params(model, _budget(level)) == expected

    @pytest.mark.parametrize("model", ["deepseek-chat", "deepseek-reasoner", ""])
    def test_retired_names_get_nothing(self, model):
        assert deepseek_effort_params(model, _budget("high")) is None


class TestMistral:
    @pytest.mark.parametrize(
        "model",
        [
            "mistral-medium-3-5",
            "mistral-small-latest",
            "mistral-small-2603",
            "mistral-large-4",
            "mistral-large-4-0",
        ],
    )
    def test_on_or_off(self, model):
        assert mistral_reasoning_effort(model, None) == "none"
        assert mistral_reasoning_effort(model, _budget("low")) == "high"
        assert mistral_reasoning_effort(model, _budget("ultrathink")) == "high"

    @pytest.mark.parametrize(
        "model",
        [
            "mistral-large-2512",
            "mistral-small-2506",
            "codestral-2508",
            "magistral-medium-latest",
        ],
    )
    def test_models_without_the_setting_get_nothing(self, model):
        assert mistral_reasoning_effort(model, _budget("high")) is None

    def test_compatible_params_wrap_the_value(self):
        assert compatible_effort_params("mistral", "mistral-medium-3-5", None) == {
            "reasoning_effort": "none"
        }
        assert compatible_effort_params("mistral", "codestral-2508", 4096) is None
        assert compatible_effort_params("unknown", "x", 4096) is None


class TestEffortPlan:
    @pytest.mark.parametrize(
        ("provider", "model", "control"),
        [
            ("anthropic", "claude-opus-5-5", "native"),
            ("claude", "sonnet", "native"),
            ("openai", "gpt-5.5", "native"),
            ("openai", "gpt-4o", "none"),
            ("google", "gemini-3.1-pro-preview", "native"),
            ("gemini", "gemini-2.0-flash", "none"),
            ("grok", "grok-4.7", "native"),
            ("grok", "grok-4.3", "none"),
            ("deepseek", "deepseek-flash", "native"),
            ("mistral", "mistral-medium-3-5", "native"),
            ("mistral", "codestral-2508", "none"),
            ("copilot", "gpt-5", "runtime"),
            ("ollama", "qwen3", "runtime"),
            ("lm-studio", "qwen3", "runtime"),
            ("windsurf", "swe-1", "none"),
            ("opencode", "anthropic/claude-sonnet", "none"),
            ("pi", "", "native"),
            ("agy", "gemini-3.8-flash", "native"),
            ("antigravity", "gemini-3.8-flash-medium", "none"),
            # No adapter: the Claude SDK runs the task (`_degraded_client`).
            ("aws", "anthropic.claude-x", "native"),
        ],
    )
    def test_control(self, provider, model, control):
        assert describe_effort(provider, model)["control"] == control

    def test_describe_serves_every_level(self):
        served = describe_effort("Grok", " grok-4.7 ")
        assert served == {
            "provider": "grok",
            "model": "grok-4.7",
            "control": "native",
            "levels": {
                "none": "low",
                "low": "low",
                "medium": "medium",
                "high": "high",
                "ultrathink": "xhigh",
            },
        }

    def test_an_unknown_level_is_read_as_medium(self):
        assert effort_plan("openai", "gpt-5.5", "bogus").sent == "medium"

    def test_every_level_has_a_plan_everywhere(self):
        for provider in ("claude", "openai", "grok", "deepseek", "mistral", "pi"):
            plans = [effort_plan(provider, "", level) for level in LEVELS]
            assert len(plans) == len(LEVELS)


class TestTraceLabel:
    def test_an_ignored_level_is_said(self):
        assert (
            effort_trace_label("grok", "grok-4.3", "high")
            == "high (not applied by this model)"
        )

    def test_none_where_nothing_reasons_is_simply_none(self):
        assert effort_trace_label("openai", "gpt-4o", "none") == "none"

    def test_a_translated_level_names_what_is_sent(self):
        assert effort_trace_label("claude", "opus", "none") == "none (sent as low)"
        assert (
            effort_trace_label("openai", "gpt-5.5", "ultrathink")
            == "ultrathink (sent as xhigh)"
        )

    def test_a_level_sent_as_itself_is_unchanged(self):
        assert effort_trace_label("openai", "gpt-5.5", "high") == "high"

    def test_runtime_providers_trace_the_level(self):
        assert effort_trace_label("copilot", "gpt-5", "high") == "high"

    def test_a_custom_budget_is_left_alone(self):
        assert effort_trace_label("grok", "grok-4.3", "12000 tokens") == "12000 tokens"


class TestRejection:
    @pytest.mark.parametrize(
        "body",
        [
            "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
            '{"error":{"message":"Unsupported value: \'reasoning.effort\'"}}',
            "Model does not support thinking",
        ],
    )
    def test_a_refusal_naming_the_effort(self, body):
        assert effort_was_rejected(400, body)
        assert effort_was_rejected(422, body)

    def test_other_refusals_and_statuses(self):
        assert not effort_was_rejected(400, "messages: invalid role")
        assert not effort_was_rejected(429, "reasoning_effort")
        assert not effort_was_rejected(500, "thinking")


class TestOllamaThink:
    def _client(self, model: str, level: str | None, capabilities, fmt="ollama"):
        from core.agent_client import LocalAgentClient

        client = LocalAgentClient(model=model, api_format=fmt, thinking_level=level)
        client._model_show = {"capabilities": capabilities}
        return client

    def test_a_thinking_model_is_told(self):
        client = self._client("qwen3:8b", "high", ["completion", "tools", "thinking"])
        assert client._ollama_think() is True
        client = self._client("qwen3:8b", "none", ["completion", "thinking"])
        assert client._ollama_think() is False

    def test_gpt_oss_reads_a_level(self):
        caps = ["completion", "tools", "thinking"]
        assert self._client("gpt-oss:20b", "medium", caps)._ollama_think() == "medium"
        assert (
            self._client("gpt-oss:120b", "ultrathink", caps)._ollama_think() == "high"
        )

    def test_a_model_that_does_not_think_is_sent_nothing(self):
        # Ollama refuses `think` there.
        client = self._client("llama3.3", "high", ["completion", "tools"])
        assert client._ollama_think() is None

    def test_no_level_or_an_openai_format_server_sends_nothing(self):
        assert self._client("qwen3", None, ["thinking"])._ollama_think() is None
        assert (
            self._client("qwen3", "high", ["thinking"], fmt="openai")._ollama_think()
            is None
        )

    def test_the_payload_carries_it(self):
        from core.agent_clients.local import _OllamaAdapter

        client = self._client("qwen3:8b", "none", ["thinking"])
        adapter = _OllamaAdapter(
            client, [], tools=[], session=None, url="http://x", num_ctx=8192
        )
        assert adapter.assemble(0)["think"] is False


def test_the_endpoint_serves_the_plan():
    from provider_api import get_effort_plan

    assert get_effort_plan("windsurf", "swe-1")["control"] == "none"
    assert get_effort_plan("deepseek", "deepseek-flash")["levels"]["none"] == "off"


def test_the_live_catalogue_keeps_deepseek_flash():
    from provider_models_catalog import _DEEPSEEK_KEEP, _supports_thinking

    assert _DEEPSEEK_KEEP.match("deepseek-flash")
    assert _supports_thinking("deepseek", "deepseek-flash")
