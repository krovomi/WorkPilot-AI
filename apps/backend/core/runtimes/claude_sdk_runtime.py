"""
ClaudeSDKRuntime: AgentRuntime for Claude Agent SDK

Uses the Claude Agent SDK for direct integration with Claude models: one
prompt, one answer (`run_session`). It had a `stream_session` too, which
awaited an async generator and so failed on its first message; nothing called
it, and it is gone with the abstract method that required it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.connectors.llm_config import ProviderConfig

from core.runtime import AgentRuntime, SessionResult, SessionStatus
from core.simple_client import create_simple_client

logger = logging.getLogger(__name__)


class ClaudeSDKRuntime(AgentRuntime):
    """Agent runtime that uses Claude Agent SDK for LLM interaction."""

    def __init__(
        self,
        spec_dir: str,
        phase: str,
        project_dir: str,
        agent_type: str,
        config: ProviderConfig,
        cli_thinking: int | None = None,
    ):
        self.spec_dir = spec_dir
        self.phase = phase
        self.project_dir = project_dir
        self.agent_type = agent_type
        self.config = config
        self.cli_thinking = cli_thinking
        self.max_turns = 10

        # Initialize SDK client
        self.client = None
        self._initialize_client()

    def _initialize_client(self):
        """Initialize the Claude SDK client."""
        try:
            # Use simple client factory for lightweight SDK integration
            self.client = create_simple_client(
                agent_type=self.agent_type,
                model=getattr(self.config, "model", "claude-3-sonnet-20240229"),
                max_thinking_tokens=self.cli_thinking,
                # create_simple_client calls cwd.resolve(): a str project_dir
                # (the factory's signature allows one) used to fail here, be
                # logged, and leave every session "not initialized".
                cwd=Path(self.project_dir) if self.project_dir else None,
                max_turns=self.max_turns,
            )
            logger.info(
                f"ClaudeSDKRuntime initialized with model: {getattr(self.config, 'model', 'default')}"
            )
        except Exception as e:
            logger.error(f"Failed to initialize Claude SDK client: {e}")
            self.client = None

    async def run_session(
        self,
        prompt: str,
        tools: list[dict[str, Any]] | None = None,
        **kwargs,
    ) -> SessionResult:
        """
        Run a Claude SDK session.

        Uses the SDK for LLM interaction with MCP server tools.
        """
        if not self.client:
            return self._create_error_session("Claude SDK client not initialized")

        try:
            return await self._execute_sdk_session(prompt)
        except Exception as e:
            # Anthropic SDK errors can include request IDs and partial auth
            # info; tracebacks include local file paths. Log full details
            # locally; surface only the exception class name to the caller
            # / streaming subscribers (websocket has no auth — see
            # streaming/websocket_server.py).
            logger.exception("Claude SDK session failed")
            return self._create_error_session(type(e).__name__)

    def _create_error_session(self, error_message: str) -> SessionResult:
        """Create an error session result."""
        return SessionResult(
            status=SessionStatus.ERROR,
            output=None,
            error=error_message,
            error_type=None,
            usage=None,
        )

    async def _execute_sdk_session(self, prompt: str) -> SessionResult:
        """Execute the SDK session and collect response."""
        async with self.client:
            await self.client.query(prompt)

            response_data = await self._collect_response_data()

            logger.info(
                f"Claude SDK session completed: {len(response_data['text'])} chars, "
                f"{response_data['tool_calls']} tools"
            )

            return SessionResult(
                status=SessionStatus.COMPLETED,
                output=response_data["text"].strip() if response_data["text"] else None,
                error=None,
                error_type=None,
                usage=response_data["usage"],
            )

    async def _collect_response_data(self) -> dict[str, Any]:
        """Collect and parse response data from SDK messages."""
        response_text = ""
        tool_calls_count = 0
        usage = None

        async for msg in self.client.receive_response():
            response_text, tool_calls_count, usage = self._process_message(
                msg, response_text, tool_calls_count, usage
            )

        return {"text": response_text, "tool_calls": tool_calls_count, "usage": usage}

    def _process_message(
        self, msg, response_text: str, tool_calls_count: int, usage
    ) -> tuple[str, int, Any]:
        """Process a single SDK message and update response data."""
        msg_type = type(msg).__name__

        if msg_type == "AssistantMessage" and hasattr(msg, "content"):
            for block in msg.content:
                response_text, tool_calls_count = self._process_content_block(
                    block, response_text, tool_calls_count
                )

        # Extract usage information if available
        if hasattr(msg, "usage") and msg.usage:
            usage = msg.usage

        return response_text, tool_calls_count, usage

    def _process_content_block(
        self, block, response_text: str, tool_calls_count: int
    ) -> tuple[str, int]:
        """Process a content block from the SDK response."""
        block_type = type(block).__name__

        if block_type == "TextBlock" and hasattr(block, "text"):
            response_text += block.text
        elif block_type == "ToolUseBlock":
            tool_calls_count += 1
        elif block_type == "ThinkingBlock" and hasattr(block, "thinking"):
            response_text += f"\n[Thinking] {block.thinking}\n"

        return response_text, tool_calls_count

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        # SDK client cleanup is handled by async context manager in sessions
        pass
