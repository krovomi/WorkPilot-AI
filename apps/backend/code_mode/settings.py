"""Whether a session is offered ``run_script``: the person's switch, then the task's.

Three values, everywhere: ``off``, ``auto`` and ``on``.

- The switch (Settings, Code mode) reaches every agent process as
  ``WORKPILOT_CODE_MODE`` (``main/agent/code-mode-env.ts``). Absent or
  malformed, it is ``off``: no session is offered the tool, which is the
  product as it was before code mode.
- A task may say more in its ``task_metadata.json``: ``codeMode`` for every
  phase (the bench writes it on the copy it replays), ``phaseCodeMode`` for one
  phase (``spec``, ``planning``, ``coding``, ``qa``). The phase wins over the
  task, the task over the switch, but nothing turns code mode on while the
  switch is ``off``.
- ``auto`` offers the tool only where it pays (``AUTO_AGENT_TYPES``): the types
  that chain many reads, searches, edits or commands. A spec writer, a
  reviewer or ideation make a few calls, and a script would not save one.

Pure apart from reading the environment and one small JSON file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ENV_VAR = "WORKPILOT_CODE_MODE"
OFF, AUTO, ON = "off", "auto", "on"
MODES = (OFF, AUTO, ON)

#: The Kanban phase an agent type works in, for ``phaseCodeMode``.
PHASE_OF_AGENT: dict[str, str] = {
    "spec_researcher": "spec",
    "spec_writer": "spec",
    "spec_self_critique": "spec",
    "planner": "planning",
    "coder": "coding",
    "qa_reviewer": "qa",
    "qa_fixer": "qa",
    "verifier": "qa",
}

#: Where ``auto`` offers the tool: many calls that a script chains, runs in
#: parallel or filters before they reach the context.
AUTO_AGENT_TYPES = frozenset(
    {
        # The same edit over many files, the searches before reading.
        "coder",
        # Lint, type check and targeted tests, independent of one another.
        "qa_reviewer",
        "qa_fixer",
        "verifier",
        # Search then filter before reading: the context phase of the spec, the
        # analyses of the code.
        "spec_researcher",
        "analyzer",
        "impact_analyzer",
        "context_mesh_analyzer",
    }
)

#: A task this small makes a few calls: ``auto`` leaves its coder alone.
_SMALL_COMPLEXITY = frozenset({"simple", "trivial"})


def _mode(value: object) -> str | None:
    if isinstance(value, str) and value.strip().lower() in MODES:
        return value.strip().lower()
    return None


def switch(environ: dict[str, str] | None = None) -> str:
    """The person's switch: ``off`` unless Settings said otherwise."""
    env = os.environ if environ is None else environ
    return _mode(env.get(ENV_VAR)) or OFF


def _task_metadata(spec_dir: Path | str | None) -> dict:
    if spec_dir is None:
        return {}
    try:
        data = json.loads(
            (Path(spec_dir) / "task_metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def effective_mode(
    agent_type: str | None,
    spec_dir: Path | str | None = None,
    environ: dict[str, str] | None = None,
) -> str:
    """``off``, ``auto`` or ``on`` for this session, the switch first."""
    global_mode = switch(environ)
    if global_mode == OFF:
        return OFF
    metadata = _task_metadata(spec_dir)
    chosen = _mode(metadata.get("codeMode")) or global_mode
    phase = PHASE_OF_AGENT.get(agent_type or "")
    per_phase = metadata.get("phaseCodeMode")
    if phase and isinstance(per_phase, dict):
        chosen = _mode(per_phase.get(phase)) or chosen
    return chosen


def offered(
    agent_type: str | None,
    spec_dir: Path | str | None = None,
    environ: dict[str, str] | None = None,
) -> bool:
    """Whether this session is offered ``run_script``."""
    mode = effective_mode(agent_type, spec_dir, environ)
    if mode == OFF:
        return False
    if mode == ON:
        return True
    if agent_type not in AUTO_AGENT_TYPES:
        return False
    if agent_type == "coder":
        complexity = _task_metadata(spec_dir).get("complexity")
        if isinstance(complexity, str) and complexity.lower() in _SMALL_COMPLEXITY:
            return False
    return True


__all__ = [
    "AUTO",
    "AUTO_AGENT_TYPES",
    "ENV_VAR",
    "MODES",
    "OFF",
    "ON",
    "PHASE_OF_AGENT",
    "effective_mode",
    "offered",
    "switch",
]
