"""The cooperative pause, and the one file that holds it.

A user can press Pause at any moment of a build. Until now the flag lived in
`implementation_plan.json`, which meant the feature only existed once planning
had already succeeded: during planning that file does not exist yet, so the
pause had nowhere to be written and the UI reported "Implementation plan not
found" for a task that was visibly running.

`pause_state.json` sits in the spec directory, which exists from the moment the
task does. It is the single store — the frontend writes it, the coder loop, the
QA loop and the spec pipeline read it — so "is this task paused?" has one
answer whatever phase is asking.

The legacy `plan["paused"]` block is still *read* (a task paused by an earlier
version stays paused across the upgrade) and never written.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PAUSE_STATE_FILE = "pause_state.json"

#: Phases a pause can be recorded in. The value is written to the file and read
#: back by the UI to say where the build will resume from, so it is a closed set
#: rather than whatever string the caller happened to pass.
PAUSE_PHASES = ("spec", "planning", "coding", "qa_review", "qa_fixing")


def _state_path(spec_dir: Path) -> Path:
    return Path(spec_dir) / PAUSE_STATE_FILE


def _read_legacy(spec_dir: Path) -> dict[str, Any] | None:
    """The pre-`pause_state.json` store: a `paused` block inside the plan."""
    plan_path = Path(spec_dir) / "implementation_plan.json"
    try:
        with open(plan_path, encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    paused = plan.get("paused")
    return paused if isinstance(paused, dict) else None


def read_pause_state(spec_dir: Path) -> dict[str, Any]:
    """Return the pause block, or `{}` when the task is not paused."""
    try:
        with open(_state_path(spec_dir), encoding="utf-8") as handle:
            state = json.load(handle)
        if isinstance(state, dict):
            return state
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    return _read_legacy(spec_dir) or {}


def is_paused(spec_dir: Path) -> bool:
    return read_pause_state(spec_dir).get("enabled") is True


def write_pause_state(
    spec_dir: Path,
    *,
    phase: str,
    subtask_id: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Mark the build paused, recording where it stopped."""
    state = {
        "enabled": True,
        "paused_at": datetime.now(timezone.utc).isoformat(),
        "paused_phase": phase if phase in PAUSE_PHASES else "coding",
        "paused_subtask_id": subtask_id,
        "provider": provider,
        "model": model,
    }
    _write(spec_dir, state)
    return state


def clear_pause_state(spec_dir: Path) -> None:
    """Lift the pause, keeping the record of where it had stopped.

    The file is rewritten rather than deleted so a resumed task still reports
    the phase it was paused in until the next event overwrites it — the UI reads
    that to say "resumed from coding" instead of losing the trace on resume.
    """
    previous = read_pause_state(spec_dir)
    _write(
        spec_dir,
        {
            "enabled": False,
            "paused_at": None,
            "paused_phase": previous.get("paused_phase"),
            "paused_subtask_id": None,
            "provider": previous.get("provider"),
            "model": previous.get("model"),
        },
    )


def _write(spec_dir: Path, state: dict[str, Any]) -> None:
    path = _state_path(spec_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except OSError:
        # Le drapeau de pause est coopératif : son écriture ne casse pas un build.
        pass
