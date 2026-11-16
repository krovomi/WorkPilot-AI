"""What watches an agent session's tool calls, as one object for ``agents.session``.

Two watchers read the same stream: the circuit breaker (``tool_breaker``),
which pauses an agent repeating itself, and the safety watch
(``safety_watch``), which snapshots the worktree, keeps the session's trust
score and counts the sandbox's limits. ``run_agent_session`` holds one of
these per session, on both of its paths (the Claude SDK and every other
``AgentClient``), and stops at the next message once either has tripped.

The safety watch is best-effort by contract: whatever goes wrong in it is
logged and the session goes on with the breaker alone, as it did before.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .safety_watch import SafetyWatch
from .tool_breaker import ToolBreaker

logger = logging.getLogger(__name__)


class SessionGuards:
    def __init__(self, spec_dir: Path, phase: str) -> None:
        self.breaker = ToolBreaker(spec_dir, phase)
        self.safety: SafetyWatch | None
        try:
            self.safety = SafetyWatch(spec_dir, phase)
        except (OSError, ValueError, KeyError) as exc:
            logger.warning("Safety watch unavailable for this session: %s", exc)
            self.safety = None

    @property
    def tripped(self) -> bool:
        return self.breaker.tripped or bool(self.safety and self.safety.tripped)

    def call(self, name: str, arguments: Any, call_id: str | None = None) -> None:
        self.breaker.call(name, arguments, call_id)
        if self.safety is not None:
            try:
                self.safety.call(name, arguments, call_id)
            except (OSError, ValueError, KeyError) as exc:
                logger.warning("Safety watch: %s", exc)

    def result(self, content: Any, is_error: bool, call_id: str | None = None) -> bool:
        tripped = self.breaker.result(content, is_error, call_id)
        if self.safety is not None:
            try:
                tripped = self.safety.result(content, is_error, call_id) or tripped
            except (OSError, ValueError, KeyError) as exc:
                logger.warning("Safety watch: %s", exc)
        return tripped

    def close(self) -> None:
        if self.safety is not None:
            try:
                self.safety.close()
            except (OSError, ValueError, KeyError) as exc:
                logger.warning("Safety watch: %s", exc)


__all__ = ["SessionGuards"]
