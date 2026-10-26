"""What the follow-through remembers between two looks at the PR.

Kept in `<spec_dir>/pr_followup.json`, next to the task's other records, so
that a restart of the app picks the loop up where it was: how many fix rounds
were spent, which head was pushed last, which review threads were answered.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

STATE_FILENAME = "pr_followup.json"
_HISTORY_CAP = 50


@dataclass
class FollowupState:
    rounds: int = 0
    """Fix rounds spent: one per QA fixer session the follow-through ran."""
    last_pushed_sha: str = ""
    handled_threads: dict[str, str] = field(default_factory=dict)
    """thread id -> id of the last comment the fixer was given. A reply after
    it makes the thread new again."""
    no_progress_heads: list[str] = field(default_factory=list)
    """Heads on which a fix round produced no commit: retrying the same head
    would spend a round to produce nothing again."""
    no_checks_polls: int = 0
    history: list[dict[str, Any]] = field(default_factory=list)

    def record(self, kind: str, head_sha: str, detail: str = "") -> None:
        self.history.append(
            {
                "at": datetime.now(UTC).isoformat(timespec="seconds"),
                "kind": kind,
                "head": head_sha[:12],
                "detail": detail[:500],
            }
        )
        del self.history[:-_HISTORY_CAP]


def load_state(spec_dir: Path) -> FollowupState:
    """The saved state, or a fresh one. A corrupt file starts over, it does
    not stop the loop: the worst case is one extra round, capped anyway."""
    path = Path(spec_dir) / STATE_FILENAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return FollowupState()
    if not isinstance(raw, dict):
        return FollowupState()
    state = FollowupState()
    state.rounds = _int(raw.get("rounds"))
    state.last_pushed_sha = str(raw.get("last_pushed_sha") or "")
    threads = raw.get("handled_threads")
    if isinstance(threads, dict):
        state.handled_threads = {str(k): str(v) for k, v in threads.items()}
    heads = raw.get("no_progress_heads")
    if isinstance(heads, list):
        state.no_progress_heads = [str(h) for h in heads]
    state.no_checks_polls = _int(raw.get("no_checks_polls"))
    history = raw.get("history")
    if isinstance(history, list):
        state.history = [h for h in history if isinstance(h, dict)][-_HISTORY_CAP:]
    return state


def save_state(spec_dir: Path, state: FollowupState) -> None:
    path = Path(spec_dir) / STATE_FILENAME
    if path.is_symlink():
        raise OSError(f"refusing to write through a symlink: {path}")
    path.write_text(json.dumps(asdict(state), indent=2) + "\n", encoding="utf-8")


def _int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0
