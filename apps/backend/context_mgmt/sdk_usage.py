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
    """The guard's client attributes, fed from raw SDK messages."""

    context_window_tokens: int | None = None
    context_usage_source = "exact"

    def __init__(self) -> None:
        self.last_context_tokens: int | None = None
        # The same per-call ledger the AgentClient wrappers keep, for the
        # cache figures of the gauge.
        self.usage_ledger = UsageLedger()
        self._counted_calls: set[str] = set()

    def update(self, message: Any) -> None:
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
