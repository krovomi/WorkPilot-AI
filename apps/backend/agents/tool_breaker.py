"""The tool-call circuit breaker: an agent that repeats itself is paused.

A model can call the same tool with the same arguments, get the same answer,
and call it again: each call paid, the whole conversation re-sent, until the
session's turn limit ends it. ``harness.domain.progress`` already stops that
inside WorkPilot's own loop; this breaker watches the stream every provider
goes through (``agents.session``): the Claude SDK, the CLI agents (Codex,
Copilot, OpenCode, pi, ACP) and the WorkPilot loop alike.

A call is the same when its tool, its arguments and its result are: a result
that changes (a test that now passes, a file that now exists) is progress, even
when the call is the same. A file the agent changed is progress too, and
forgets what was counted: reading a file again after editing it is how work
goes. Only a call that keeps returning the same thing, with nothing changed in
between, counts towards the limit.

The limit is ``loop_detection.max_same_tool_call`` of ``workpilot.policy.yaml``
when the repository sets one, the team's rule: the machine's own setting
(``WORKPILOT_TOOL_BREAKER_LIMIT``) can only make it stricter, never turn it off.

At the limit the session ends and the build is paused (``reason: tool_loop``),
in every copy of its spec directory, and the trip is written to the policy's
audit trail. The card says which tool repeated itself,
and the person resumes it, or changes the approach, when they choose. Pure apart
from that pause; table-tested in ``tests/agents/test_tool_breaker.py``.

Because every result passes here, it is also where a pause the person asked
for mid-session takes effect: when ``pause_state.json`` says the task is
paused (the voice assistant's spoken « stop » writes it without killing the
process), the session ends after the result of the call in flight, so that
call finishes and the next one never starts. The loop's own checkpoint then
stops the build at the pause, as it would between two sessions.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import deque
from pathlib import Path
from typing import Any

from cost_budget.spend import project_root
from foundation.pause_state import is_paused, pause_task
from security import policy_audit
from security.guardrail_policy import load_policy

logger = logging.getLogger(__name__)

#: Identical calls, with nothing changed in between, before the breaker trips.
DEFAULT_LIMIT = 5
#: ``0`` turns the breaker off; any other whole number replaces the limit.
LIMIT_ENV = "WORKPILOT_TOOL_BREAKER_LIMIT"
PAUSE_REASON = "tool_loop"

#: Tools that change a file, whatever the provider calls them. Their success is
#: progress: the counts start over.
WRITE_TOOLS = frozenset(
    {
        "write",
        "edit",
        "multiedit",
        "notebookedit",
        "write_file",
        "edit_file",
        "create_file",
        "apply_patch",
        "patch",
        "str_replace_editor",
        "str_replace_based_edit_tool",
        "replace",
    }
)

#: The session's log phase, as the pause store names phases.
_PAUSE_PHASE = {"planning": "planning", "coding": "coding", "validation": "qa_review"}


def configured_limit() -> int:
    raw = (os.environ.get(LIMIT_ENV) or "").strip()
    if not raw:
        return DEFAULT_LIMIT
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_LIMIT
    return max(value, 0)


def policy_limit(spec_dir: Path) -> int | None:
    """``loop_detection.max_same_tool_call`` of the task's project, if it sets one."""
    project = project_root(Path(spec_dir))
    if project is None:
        return None
    governance = load_policy(project).governance
    return governance.max_same_tool_call if governance else None


def effective_limit(spec_dir: Path) -> tuple[int, bool]:
    """The breaker's limit for a session, and whether the repository's policy set it."""
    own = configured_limit()
    team = policy_limit(spec_dir)
    if team is None:
        return own, False
    # The default gives way to the team's choice; a limit the person set may
    # only be stricter.
    chosen = (os.environ.get(LIMIT_ENV) or "").strip().lstrip("-").isdigit()
    if chosen and own and own < team:
        return own, False
    return team, True


def _digest(name: str, arguments: Any, result: Any) -> str:
    digest = hashlib.sha256()
    digest.update(name.encode("utf-8"))
    digest.update(b"\0")
    digest.update(json.dumps(arguments, sort_keys=True, default=str).encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(result).encode("utf-8", errors="replace"))
    return digest.hexdigest()


def _is_write(name: str) -> bool:
    bare = name.rsplit("__", 1)[-1].lower()
    return bare in WRITE_TOOLS


class ToolBreaker:
    """Counts a session's identical tool calls and pauses the build at the limit."""

    def __init__(self, spec_dir: Path, phase: str, limit: int | None = None) -> None:
        self.spec_dir = Path(spec_dir)
        self.phase = _PAUSE_PHASE.get(str(phase), "coding")
        self.from_policy = False
        if limit is None:
            self.limit, self.from_policy = effective_limit(self.spec_dir)
        else:
            self.limit = max(limit, 0)
        self.tripped = False
        #: The session ends because the task was paused while it ran, not for a loop.
        self.pause_requested = False
        self._pending: dict[str, tuple[str, Any]] = {}
        self._order: deque[tuple[str, Any]] = deque()
        self._counts: dict[str, int] = {}

    def call(self, name: str, arguments: Any, call_id: str | None = None) -> None:
        """A tool call the model made; its result comes later."""
        entry = (name or "", arguments if arguments is not None else {})
        if call_id:
            self._pending[call_id] = entry
        else:
            self._order.append(entry)

    def _take(self, call_id: str | None) -> tuple[str, Any] | None:
        if call_id and call_id in self._pending:
            return self._pending.pop(call_id)
        if self._order:
            return self._order.popleft()
        if self._pending:
            # A provider that names its calls but not its results: oldest first.
            return self._pending.pop(next(iter(self._pending)))
        return None

    def result(self, content: Any, is_error: bool, call_id: str | None = None) -> bool:
        """The result of a call. True once, when this result trips the breaker."""
        entry = self._take(call_id)
        if self.tripped:
            return False
        if is_paused(self.spec_dir):
            self.tripped = True
            self.pause_requested = True
            print(
                "\n[Pause] The task was paused: the session ends after this tool call.",
                flush=True,
            )
            return True
        if entry is None or not self.limit:
            return False
        name, arguments = entry
        if _is_write(name) and not is_error:
            self._counts.clear()
            return False
        key = _digest(name, arguments, content)
        count = self._counts.get(key, 0) + 1
        self._counts[key] = count
        if count < self.limit:
            return False
        self.tripped = True
        self._pause(name, count)
        return True

    def _pause(self, name: str, count: int) -> None:
        logger.warning(
            "Circuit breaker: %s returned the same result %d times in a row "
            "with nothing changed; pausing the task.",
            name,
            count,
        )
        print(
            f"\n[Circuit breaker] {name} called {count} times with the same "
            "arguments and the same result: the task is paused.",
            flush=True,
        )
        pause_task(
            self.spec_dir,
            phase=self.phase,
            reason=PAUSE_REASON,
            detail={"breaker": {"tool": name, "repeats": count, "limit": self.limit}},
        )
        project = project_root(self.spec_dir)
        if project is not None:
            policy_audit.record(
                project,
                decision="tool_loop",
                tool=name,
                rules=["loop_detection.max_same_tool_call"] if self.from_policy else [],
                reason=f"{name} returned the same result {count} times with nothing "
                "changed in between; the task is paused.",
                task=self.spec_dir.name,
            )


__all__ = [
    "DEFAULT_LIMIT",
    "LIMIT_ENV",
    "PAUSE_REASON",
    "ToolBreaker",
    "configured_limit",
    "effective_limit",
    "policy_limit",
]
