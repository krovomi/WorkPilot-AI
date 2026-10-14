"""Context fill of a Claude Agent SDK stream.

``ClaudeAgentClient`` measures it while it wraps the SDK client. The spec
pipeline reads the raw ``ClaudeSDKClient`` stream instead; ``SdkUsageProbe``
gives the guard the same three attributes from that stream.
"""

from __future__ import annotations

from typing import Any

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

    def update(self, message: Any) -> None:
        if type(message).__name__ != "AssistantMessage":
            return
        fill = claude_context_fill(getattr(message, "usage", None))
        if fill:
            self.last_context_tokens = fill
