"""`ClaudeAgentClient` — wraps `claude_agent_sdk.ClaudeSDKClient`.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from context_mgmt.sdk_usage import claude_context_fill
from harness.domain import from_split_cache

from .base import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)

# =============================================================================
# Claude Agent Client — wraps ClaudeSDKClient
# =============================================================================


class ClaudeAgentClient(AgentClient):
    """Agent client backed by Claude Agent SDK (ClaudeSDKClient).

    This is a thin wrapper that adapts ClaudeSDKClient messages into
    the AgentMessage format. For backward compatibility, the raw SDK
    messages are preserved in AgentMessage.raw so that existing
    stream processors (process_sdk_stream) can still inspect them
    with hasattr()/getattr() patterns.
    """

    def __init__(self, sdk_client: Any):
        """
        Args:
            sdk_client: A configured ClaudeSDKClient instance.
        """
        self._client = sdk_client
        # Expose the resolved model so the provider-agnostic session runner can
        # attribute log entries to the RIGHT model (session.py reads
        # `getattr(client, "model", "unknown")`). Without this the Claude client
        # reported "unknown", which the label formatter turned into the stale
        # default "Claude Opus 4.6" for every phase — mislabelling the feed and
        # breaking the per-LLM log filter (entries tagged under the wrong model
        # never matched the phase's selected model, so the view showed no logs).
        # Mirrors the raw-SDK path (session.py: getattr(client.options, "model")).
        self.model = (
            getattr(getattr(sdk_client, "options", None), "model", None) or "unknown"
        )
        # Captured during the last receive_response() iteration so callers
        # on the provider-agnostic path (session.py:_run_agent_client_session)
        # can persist session_id / usage just like the raw SDK path does.
        self.last_result_msg: Any | None = None
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None
        # Context fill of the latest assistant turn (context_mgmt's guard):
        # what the request carried, cached or not.
        self.last_context_tokens: int | None = None
        self.context_window_tokens: int | None = None
        self.context_usage_source = "exact"
        # Optional history queued by resume() for the next query() call.
        self._resumed_history: list[AgentMessage] = []

    def resumes_native_session(self) -> bool:
        """True when the SDK was told to rehydrate an earlier session.

        The SDK then already holds that transcript, and replaying the
        conversation log on top of it would hand the model the same turns twice.
        """
        options = getattr(self._client, "options", None)
        return bool(getattr(options, "resume", None))

    async def query(self, prompt: str) -> None:
        # Reset per-query observables so callers always see fresh data.
        self.last_result_msg = None
        self.last_session_id = None
        self.last_usage = None
        # If resume(history) was called, prepend the transcript so the LLM
        # has the same context the previous provider had. Consumed once.
        if self._resumed_history:
            preamble = self._format_history_as_preamble(self._resumed_history)
            self._resumed_history = []  # consume
            prompt = preamble + "\n\n" + prompt
        await self._client.query(prompt)

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Yield AgentMessages wrapping raw SDK messages.

        The raw SDK message is preserved in AgentMessage.raw so that
        existing code using hasattr(msg, 'content') patterns continues
        to work during the migration period.
        """
        self._start_usage_ledger()
        # The CLI streams one AssistantMessage per content block, each carrying
        # the usage of the API call they came from: one call, counted once.
        counted_calls: set[str] = set()
        async for raw_msg in self._client.receive_response():
            # The init SystemMessage names the session before any work is
            # done; session.py persists it right away so a run interrupted
            # mid-session can be resumed on that session, not the one before.
            if self.last_session_id is None:
                _data = getattr(raw_msg, "data", None)
                _sid = getattr(raw_msg, "session_id", None) or (
                    _data.get("session_id") if isinstance(_data, dict) else None
                )
                if isinstance(_sid, str) and _sid:
                    self.last_session_id = _sid
            # Snapshot the ResultMessage for post-loop consumers (usage,
            # session_id persistence). This is the only place we can see it
            # on the AgentClient path — without it, the Kanban "Reprendre"
            # button can't find a session_id when the user uses the
            # provider-agnostic factory.
            if getattr(raw_msg, "subtype", None) == "compact_boundary":
                # Native compaction rebuilt the thread: its next call starts cold.
                self.usage_ledger.boundary()
            if type(raw_msg).__name__ == "AssistantMessage":
                _usage = getattr(raw_msg, "usage", None)
                _fill = claude_context_fill(_usage)
                if _fill:
                    self.last_context_tokens = _fill
                _call_id = getattr(raw_msg, "message_id", None)
                if not _call_id or _call_id not in counted_calls:
                    if _call_id:
                        counted_calls.add(_call_id)
                    # A sub-agent's calls share its own prefix, not the parent's.
                    self._record_call(
                        from_split_cache(_usage),
                        thread=getattr(raw_msg, "parent_tool_use_id", None),
                    )
            if type(raw_msg).__name__ == "ResultMessage":
                self.last_result_msg = raw_msg
                self.last_session_id = getattr(raw_msg, "session_id", None)
                _u = getattr(raw_msg, "usage", None)
                if isinstance(_u, dict):
                    self.last_usage = {
                        "input_tokens": _u.get("input_tokens", 0),
                        "output_tokens": _u.get("output_tokens", 0),
                        "cost_usd": getattr(raw_msg, "total_cost_usd", None) or 0.0,
                        "cache_creation_input_tokens": _u.get(
                            "cache_creation_input_tokens", 0
                        ),
                        "cache_read_input_tokens": _u.get("cache_read_input_tokens", 0),
                    }
            yield self._wrap_sdk_message(raw_msg)

    def _wrap_sdk_message(self, raw_msg: Any) -> AgentMessage:
        """Convert a raw Claude SDK message to AgentMessage.

        For backward compatibility, the raw message is attached so that
        existing stream processing code can still access SDK-specific
        attributes (e.g., msg.raw.content, msg.raw.structured_output).
        """
        msg_type = type(raw_msg).__name__

        # Determine role from SDK message type
        if msg_type == "AssistantMessage":
            role = MessageRole.ASSISTANT
        elif msg_type == "UserMessage":
            role = MessageRole.USER
        elif msg_type == "SystemMessage":
            role = MessageRole.SYSTEM
        else:
            # ThinkingBlock, ToolUseBlock, ToolResultBlock, ResultMessage
            # are content-level objects, not message-level. Wrap them
            # as system messages with appropriate content blocks.
            role = MessageRole.SYSTEM

        blocks = self._extract_content_blocks(raw_msg, msg_type)
        return AgentMessage(role=role, content=blocks, raw=raw_msg)

    def _extract_content_blocks(
        self, raw_msg: Any, msg_type: str
    ) -> list[ContentBlock]:
        """Extract ContentBlocks from a raw SDK message."""
        blocks: list[ContentBlock] = []

        # ThinkingBlock
        if msg_type == "ThinkingBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "thinking"
        ):
            thinking_text = getattr(raw_msg, "thinking", "") or getattr(
                raw_msg, "text", ""
            )
            if thinking_text:
                blocks.append(
                    ContentBlock(type=ContentBlockType.THINKING, text=thinking_text)
                )
            return blocks

        # ToolUseBlock (top-level)
        if msg_type == "ToolUseBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "tool_use"
        ):
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name=getattr(raw_msg, "name", ""),
                    tool_id=getattr(raw_msg, "id", "unknown"),
                    tool_input=getattr(raw_msg, "input", {}),
                )
            )
            return blocks

        # ToolResultBlock (top-level)
        if msg_type == "ToolResultBlock" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "tool_result"
        ):
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    tool_use_id=getattr(raw_msg, "tool_use_id", "unknown"),
                    is_error=getattr(raw_msg, "is_error", False),
                    result_content=getattr(raw_msg, "content", ""),
                )
            )
            return blocks

        # ResultMessage
        if msg_type == "ResultMessage" or (
            hasattr(raw_msg, "type") and getattr(raw_msg, "type", "") == "result"
        ):
            block = ContentBlock(
                type=ContentBlockType.RESULT,
                subtype=getattr(raw_msg, "subtype", None),
            )
            if hasattr(raw_msg, "structured_output") and raw_msg.structured_output:
                block.structured_output = raw_msg.structured_output
            blocks.append(block)
            return blocks

        # AssistantMessage / UserMessage with .content list
        if hasattr(raw_msg, "content"):
            for item in raw_msg.content:
                item_type = type(item).__name__
                if item_type == "TextBlock" and hasattr(item, "text"):
                    blocks.append(
                        ContentBlock(type=ContentBlockType.TEXT, text=item.text)
                    )
                elif (
                    item_type == "ToolUseBlock"
                    or getattr(item, "type", "") == "tool_use"
                ):
                    blocks.append(
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=getattr(item, "name", ""),
                            tool_id=getattr(item, "id", "unknown"),
                            tool_input=getattr(item, "input", {}),
                        )
                    )
                elif (
                    item_type == "ToolResultBlock"
                    or getattr(item, "type", "") == "tool_result"
                ):
                    result_content = getattr(item, "content", "")
                    if isinstance(result_content, list):
                        result_content = " ".join(
                            str(getattr(c, "text", c)) for c in result_content
                        )
                    blocks.append(
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=getattr(item, "tool_use_id", "unknown"),
                            is_error=getattr(item, "is_error", False),
                            result_content=result_content,
                        )
                    )

        # Structured output on any message
        if hasattr(raw_msg, "structured_output") and raw_msg.structured_output:
            blocks.append(
                ContentBlock(
                    type=ContentBlockType.STRUCTURED_OUTPUT,
                    structured_output=raw_msg.structured_output,
                )
            )

        return blocks

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "claude"

    async def __aenter__(self):
        if hasattr(self._client, "__aenter__"):
            await self._client.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if hasattr(self._client, "__aexit__"):
            await self._client.__aexit__(exc_type, exc_val, exc_tb)

    @property
    def inner(self) -> Any:
        """Access the underlying ClaudeSDKClient for backward-compatible code paths."""
        return self._client
