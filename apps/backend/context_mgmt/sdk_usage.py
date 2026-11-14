"""Context fill of a Claude Agent SDK stream.

``ClaudeAgentClient`` measures it while it wraps the SDK client. The spec
pipeline reads the raw ``ClaudeSDKClient`` stream instead; ``SdkUsageProbe``
gives the guard the same three attributes from that stream.
"""

from __future__ import annotations

from typing import Any

from harness.domain import UsageLedger, from_split_cache

# What one Claude request carried, cached or not: the context window in use.
_FILL_KEYS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def claude_context_fill(usage: Any) -> int:
    """Tokens an ``AssistantMessage.usage`` puts in the window; 0 if unknown."""
    if not isinstance(usage, dict):
        return 0
    return sum(int(usage.get(key) or 0) for key in _FILL_KEYS)


class SdkUsageProbe:
    """The guard's client attributes, fed from raw SDK messages.

    It also keeps what ``agents.session.record_client_usage`` reads from a
    client (``last_usage``, ``usage_ledger``, ``model``, ``provider_name()``),
    so a spec session counts in the project's usage ledgers like a build's.
    """

    context_window_tokens: int | None = None
    context_usage_source = "exact"

    def __init__(self, model: str = "", provider: str = "claude") -> None:
        self.model = model
        self._provider = provider
        self.last_usage: dict | None = None
        self.last_context_tokens: int | None = None
        # The same per-call ledger the AgentClient wrappers keep, for the
        # cache figures of the gauge.
        self.usage_ledger = UsageLedger()
        self._counted_calls: set[str] = set()

    def provider_name(self) -> str:
        return self._provider

    def update(self, message: Any) -> None:
        if type(message).__name__ == "ResultMessage":
            self._note_result(message)
            return
        if getattr(message, "subtype", None) == "compact_boundary":
            # Native compaction rebuilt the thread: its next call starts cold.
            self.usage_ledger.boundary()
            return
        if type(message).__name__ != "AssistantMessage":
            return
        usage = getattr(message, "usage", None)
        fill = claude_context_fill(usage)
        if fill:
            self.last_context_tokens = fill
        # One AssistantMessage per content block, one usage per call.
        call_id = getattr(message, "message_id", None)
        if call_id and call_id in self._counted_calls:
            return
        if call_id:
            self._counted_calls.add(call_id)
        self.usage_ledger.record(
            from_split_cache(usage),
            thread=getattr(message, "parent_tool_use_id", None),
        )

    def _note_result(self, message: Any) -> None:
        """The session's totals and price, as the SDK reports them at the end."""
        usage = getattr(message, "usage", None)
        if not isinstance(usage, dict):
            return
        self.last_usage = {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cost_usd": getattr(message, "total_cost_usd", None) or 0.0,
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
        }
