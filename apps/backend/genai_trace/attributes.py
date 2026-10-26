"""The ``gen_ai.*`` attributes of a span, from WorkPilot's own facts.

OpenTelemetry's GenAI semantic conventions (still "Development" status, but
what Langfuse, Phoenix and Jaeger read) name three operations that WorkPilot
has: ``invoke_agent`` (one agent response), ``chat`` (one model call) and
``execute_tool`` (one tool call). This module builds their attributes and
nothing else: pure functions, table-tested in ``tests/genai_trace``.

Two rules hold everywhere:

* **No content.** No prompt, no output, no tool argument or result, no error
  message: names, counts and identifiers only. A collector is a third party,
  and a prompt carries the user's code.
* **Unknown is not zero.** A provider that reports no usage gets no token
  attribute and ``workpilot.usage.source = "unreported"``; a session whose
  tokens were counted from characters says ``"estimated"``. A dashboard that
  sums tokens can tell the three apart instead of averaging a zero in.
"""

from __future__ import annotations

from typing import Any, Protocol


class CallMeasure(Protocol):
    """What ``harness.domain.usage.CallUsage`` carries (read, never imported:
    the harness imports this package, and an import back would be a cycle)."""

    prompt: int | None
    output: int | None
    cache_read: int | None
    cache_write: int | None


# WorkPilot provider ids (capabilities/providers.yaml) that have a well-known
# `gen_ai.provider.name`. The others keep their own id, as the conventions
# allow for a provider they do not list.
_WELL_KNOWN = {
    "claude": "anthropic",
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "gcp.gemini",
    "mistral": "mistral_ai",
    "deepseek": "deepseek",
    "grok": "x_ai",
    "aws": "aws.bedrock",
}

#: Characters per token for an estimate: the usual rule of thumb for English
#: and code. It is a rough count, and the span says so.
CHARS_PER_TOKEN = 4

USAGE_REPORTED = "reported"
USAGE_UNREPORTED = "unreported"
USAGE_ESTIMATED = "estimated"


def provider_attribute(provider: str) -> str:
    """The `gen_ai.provider.name` value for a WorkPilot provider id."""
    key = (provider or "").strip().lower()
    return _WELL_KNOWN.get(key, key or "unknown")


def agent_attributes(
    *,
    provider: str,
    model: str | None,
    agent: str,
    spec_id: str | None = None,
) -> dict[str, str]:
    """An ``invoke_agent`` span: who ran, on what, for which task."""
    attributes = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": provider_attribute(provider),
        "gen_ai.agent.name": agent,
        "workpilot.provider": provider or "unknown",
    }
    if model:
        attributes["gen_ai.request.model"] = model
    if spec_id:
        attributes["workpilot.spec_id"] = spec_id
    return attributes


def usage_attributes(usage: CallMeasure | Any | None) -> dict[str, int | str]:
    """Token counts of one call or one session, only those the provider gave.

    ``gen_ai.usage.input_tokens`` is the whole prompt, cache included, as the
    conventions define it; the cache reads and writes have their own keys.
    """
    if usage is None:
        return {"workpilot.usage.source": USAGE_UNREPORTED}
    attributes: dict[str, int | str] = {}
    pairs = (
        ("gen_ai.usage.input_tokens", usage.prompt),
        ("gen_ai.usage.output_tokens", usage.output),
        ("gen_ai.usage.cache_read.input_tokens", usage.cache_read),
        ("gen_ai.usage.cache_creation.input_tokens", usage.cache_write),
        ("gen_ai.usage.reasoning.output_tokens", getattr(usage, "reasoning", None)),
    )
    for key, value in pairs:
        if value is not None:
            attributes[key] = value
    has_tokens = usage.prompt is not None or usage.output is not None
    attributes["workpilot.usage.source"] = (
        USAGE_REPORTED if has_tokens else USAGE_UNREPORTED
    )
    return attributes


def estimated_usage(prompt_chars: int, output_chars: int) -> dict[str, int | str]:
    """Token counts read from characters, for a provider that reports none."""
    return {
        "gen_ai.usage.input_tokens": _tokens(prompt_chars),
        "gen_ai.usage.output_tokens": _tokens(output_chars),
        "workpilot.usage.source": USAGE_ESTIMATED,
    }


def estimate_tokens(chars: int) -> int:
    """Characters as tokens, rounded up: a non-empty text is never 0 tokens."""
    return _tokens(chars)


def _tokens(chars: int) -> int:
    chars = max(0, int(chars))
    return -(-chars // CHARS_PER_TOKEN)


def chat_attributes(
    *, provider: str, model: str | None, thread: str | None = None
) -> dict[str, str]:
    """A ``chat`` span: one model call."""
    attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": provider_attribute(provider),
        "workpilot.provider": provider or "unknown",
    }
    if model:
        attributes["gen_ai.request.model"] = model
    if thread:
        # A sub-agent's calls: the conventions have no key for it yet.
        attributes["workpilot.thread"] = thread
    return attributes


def tool_attributes(name: str, call_id: str | None) -> dict[str, str]:
    """An ``execute_tool`` span: the tool's name and call id, never its input."""
    attributes = {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": name or "unknown",
    }
    if call_id:
        attributes["gen_ai.tool.call.id"] = call_id
    return attributes
