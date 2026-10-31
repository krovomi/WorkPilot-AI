"""The agent runtime as a port: what a unit needs to start an LLM session.

``core`` builds every LLM client (``create_client``, ``create_agent_client``,
``create_simple_client``) and ``agents.session`` runs them, so a unit that
imported either to start one utility session (the merge resolver, the Linear
updater, the insight extractor, the architecture reviewer) sat in the agents'
import cycle: ``core`` and ``agents`` import half the backend. Those units
now ask this port, which imports nothing of the backend, and ``core``
installs the implementation when it is imported (``core/agent_runtime.py``).

The port adds no client of its own: every call goes to the same factories,
with the same hooks, tool rights and authentication rules
(``docs/rules/backend.md``). It only reverses the import.

``current()`` is ``None`` until ``core`` is imported. Every process that runs
an agent imports ``core`` before it reaches one of these units; a caller that
gets ``None`` takes the path it already had for "no SDK, no token".
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol


class AgentRuntime(Protocol):
    """The calls a unit outside ``core`` may make to start a session."""

    def get_auth_token(self) -> str | None:
        """The provider token ``core.auth`` reads, or ``None``."""

    def require_auth_token(self) -> str:
        """The token, or ``ValueError`` with the message ``core.auth`` gives."""

    def ensure_claude_code_oauth_token(self) -> None:
        """Make the token visible to the Claude SDK subprocess."""

    def create_simple_client(self, **kwargs: Any) -> Any:
        """``core.simple_client.create_simple_client``."""

    def create_agent_client(self, **kwargs: Any) -> Any:
        """``core.client.create_agent_client``."""

    def create_agent_runtime(self, **kwargs: Any) -> Any:
        """``core.runtimes.create_agent_runtime``."""

    async def run_agent_session(
        self, client: Any, message: str, spec_dir: Path, **kwargs: Any
    ) -> tuple[str, str, dict]:
        """``agents.session.run_agent_session``."""


_runtime: AgentRuntime | None = None


def install(runtime: AgentRuntime) -> None:
    """Called by ``core`` when it is imported; the last install wins."""
    global _runtime
    _runtime = runtime


def current() -> AgentRuntime | None:
    """The installed runtime, or ``None`` before ``core`` is imported."""
    return _runtime
