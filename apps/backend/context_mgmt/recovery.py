"""Recover from "prompt too long" with a fresh thread instead of halting.

Retrying the same conversation fails identically, which is why the build used
to stop and wait for a person. A clear changes the conversation: the next
session starts from a handoff note. Allowed once per subtask — a prompt that
is too long right after a clear is too long on its own, and halting is then
the right answer again.
"""

from __future__ import annotations

import json
from pathlib import Path

from .decide import Decision
from .policy import load_context_policy

_STATE = ("context", "state.json")


def _state(spec_dir: Path) -> dict:
    try:
        data = json.loads(Path(spec_dir, *_STATE).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def recover_from_prompt_too_long(
    spec_dir: Path,
    project_dir: Path,
    phase: str,
    subtask_id: str | None,
    *,
    provider: str = "",
    model: str = "",
) -> bool:
    """Clear the thread once for this subtask. True when the caller may retry."""
    if not load_context_policy(spec_dir).enabled:
        return False
    state = _state(spec_dir)
    recoveries = state.setdefault("recoveries", {})
    key = f"{phase}:{subtask_id or '-'}"
    if recoveries.get(key, 0) >= 1:
        return False
    try:
        from core.conversation_log import read_log

        from .actions import apply_clear
        from .handoff import deterministic_handoff

        entries = read_log(spec_dir, provider, model) if provider and model else []
        apply_clear(
            spec_dir,
            deterministic_handoff(spec_dir, project_dir, phase, subtask_id, entries),
        )
    except Exception:  # noqa: BLE001 - the caller halts as before
        return False
    recoveries[key] = recoveries.get(key, 0) + 1
    try:
        path = Path(spec_dir, *_STATE)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        # Without the count a second recovery may run; the clear itself is done.
        pass
    try:
        from core.task_event import TaskEventEmitter

        decision = Decision("clear", "auto", "prompt too long for the context window")
        TaskEventEmitter.from_spec_dir(spec_dir).emit(
            "CONTEXT_ACTION_APPLIED",
            {
                "action": decision.action,
                "trigger": decision.trigger,
                "phase": phase,
                "subtaskId": subtask_id,
                "provider": provider,
                "native": False,
                "beforePct": 100.0,
                "afterPct": None,
                "reason": decision.reason,
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return True
