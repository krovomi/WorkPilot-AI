"""
Core Runtime Classes for Agent Execution
========================================

Base classes and types for agent runtime implementations.
"""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any


class SessionStatus(Enum):
    """Status of an agent session."""

    STARTING = "starting"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ERROR = "error"


class ErrorType(Enum):
    """Types of errors that can occur during agent execution."""

    TIMEOUT = "timeout"
    AUTHENTICATION = "authentication"
    RATE_LIMIT = "rate_limit"
    TOOL_ERROR = "tool_error"
    LLM_ERROR = "llm_error"
    UNKNOWN = "unknown"


class SessionResult:
    """Result of an agent session."""

    def __init__(
        self,
        status: SessionStatus,
        output: str | None = None,
        error: str | None = None,
        error_type: ErrorType | None = None,
        usage: dict[str, Any] | None = None,
    ):
        self.status = status
        self.output = output
        self.error = error
        self.error_type = error_type
        self.usage = usage or {}


class AgentRuntime(ABC):
    """A one-shot agent session: one prompt in, one `SessionResult` out."""

    @abstractmethod
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""

    @abstractmethod
    async def run_session(
        self, prompt: str, tools: list[dict[str, Any]] | None = None, **kwargs
    ) -> SessionResult:
        """Run an agent session on `prompt` and return its outcome."""
