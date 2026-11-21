"""Whether the swarm may start its next wave: the task's pause and its policy.

A swarm is many coders at once, so a stop has to reach the orchestrator, not
only each worker. Before each wave and before each retry (the launch
included), the orchestrator asks :func:`stop_reason`:

- **The task is paused**, in any copy of its spec directory. A worker that
  pauses (the circuit breaker, its own policy watch, the voice assistant's
  « stop ») writes its own copy and the main project's one, the copy the card
  reads, but not the task worktree's one that the orchestrator holds: so every
  copy is read.
- **The policy says stop**: outside the hours, past a token budget, or the
  policy itself invalid (``agents.policy_watch.stop_verdict``). The task is
  then paused here, with the reason the card explains, and the decision goes
  to the audit trail, as it would before a session of the task's own coder.

A worker already running finishes on its own: its session stops at its next
tool call, after the action under way, and its pause is the one above.
"""

from __future__ import annotations

from pathlib import Path

from foundation.pause_state import is_paused, read_pause_state, task_spec_dirs

from ..policy_watch import policy_pause_before_session


def _paused(spec_dir: Path) -> str | None:
    """The reason the task is already paused, from whichever copy says so."""
    for folder in task_spec_dirs(spec_dir):
        if is_paused(folder):
            return str(read_pause_state(folder).get("reason") or "paused")
    return None


def stop_reason(spec_dir: Path) -> str | None:
    """Why no new wave or retry may start; ``None`` when the swarm goes on."""
    return _paused(spec_dir) or policy_pause_before_session(spec_dir, "coding")


__all__ = ["stop_reason"]
