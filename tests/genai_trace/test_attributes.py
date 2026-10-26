"""The gen_ai.* attributes: provider names, usage, and what never goes in."""

from __future__ import annotations

import pytest
from genai_trace import attributes as attrs
from genai_trace.tracer import traces_url
from harness.domain.usage import CallUsage


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("claude", "anthropic"),
        ("openai", "openai"),
        ("google", "gcp.gemini"),
        ("mistral", "mistral_ai"),
        ("deepseek", "deepseek"),
        ("grok", "x_ai"),
        ("aws", "aws.bedrock"),
        # No well-known name: the WorkPilot id, as the conventions allow.
        ("copilot", "copilot"),
        ("ollama", "ollama"),
        ("", "unknown"),
    ],
)
def test_provider_names(provider: str, expected: str) -> None:
    assert attrs.provider_attribute(provider) == expected


def test_agent_attributes_name_the_agent_model_and_task() -> None:
    assert attrs.agent_attributes(
        provider="copilot", model="gpt-5", agent="coder", spec_id="001-login"
    ) == {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "copilot",
        "gen_ai.agent.name": "coder",
        "gen_ai.request.model": "gpt-5",
        "workpilot.provider": "copilot",
        "workpilot.spec_id": "001-login",
    }


def test_reported_usage_counts_the_whole_prompt_as_input() -> None:
    usage = CallUsage(prompt=1200, cache_read=1000, cache_write=None, output=80)
    assert attrs.usage_attributes(usage) == {
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 80,
        "gen_ai.usage.cache_read.input_tokens": 1000,
        "workpilot.usage.source": "reported",
    }


def test_unknown_usage_is_never_zero() -> None:
    assert attrs.usage_attributes(None) == {"workpilot.usage.source": "unreported"}
    empty = CallUsage(prompt=None, cache_read=None, cache_write=None, output=None)
    assert attrs.usage_attributes(empty) == {"workpilot.usage.source": "unreported"}


def test_estimate_says_so_and_rounds_up() -> None:
    assert attrs.estimated_usage(9, 1) == {
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 1,
        "workpilot.usage.source": "estimated",
    }
    assert attrs.estimate_tokens(0) == 0


def test_tool_attributes_carry_no_input() -> None:
    assert attrs.tool_attributes("Bash", "call-1") == {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "Bash",
        "gen_ai.tool.call.id": "call-1",
    }


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        ("http://localhost:4318", "http://localhost:4318/v1/traces"),
        (
            "https://cloud.langfuse.com/api/public/otel/",
            "https://cloud.langfuse.com/api/public/otel/v1/traces",
        ),
        (None, None),
        ("", None),
        ("localhost:4318", None),
        ("file:///tmp/x", None),
        # A key in the URL would be printed by every log that shows it.
        ("https://user:key@collector.example.com", None),
    ],
)
def test_traces_url(endpoint: str | None, expected: str | None) -> None:
    assert traces_url(endpoint) == expected
