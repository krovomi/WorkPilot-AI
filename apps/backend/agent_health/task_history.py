"""Agent runs read from a project's Kanban tasks.

The monitor used to score only what a client posted to ``/record``, and no
client ever did: the panel always said "no agent run recorded". The real
history is on disk. Each task keeps ``task_logs.json`` in its spec folder,
with one entry per phase (planning, coding, validation): its status, when it
started and finished, and log entries that name the provider and model that
wrote them. One finished phase is one run of that agent on that model.

A task's spec folder exists twice while it runs: in the project
(``.workpilot/specs/<spec>/``) and in its worktree
(``.workpilot/worktrees/tasks/<spec>/.workpilot/specs/<spec>/``). The copy
updated last is the one read, so a task is never counted twice.

What is counted, per phase:

* ``completed`` → a success; ``failed`` → a failure. A phase still
  ``pending`` or ``active`` has not finished and is not a run.
* duration = ``completed_at - started_at`` (0 when either is missing);
* retries = phase starts beyond the first (a phase restarted after an
  error logs a second ``phase_start``);
* error = the last ``error`` entry of the phase, cut to 200 characters.

The per-LLM copies (``task_logs.<provider>-<model>.json``) repeat entries of
the shared file and are not read.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .monitor import AgentRun, HealthMonitor

logger = logging.getLogger(__name__)

LOG_FILE = "task_logs.json"

#: Phase of ``task_logs.json`` → the agent that runs it.
PHASE_ROLES: dict[str, str] = {
    "planning": "planner",
    "coding": "coder",
    "validation": "qa",
}

FINISHED = {"completed": True, "failed": False}

MAX_ERROR_CHARS = 200


@dataclass(frozen=True)
class AgentKey:
    """Who ran a phase: the agent's role, and the provider and model it ran on."""

    role: str
    provider: str
    model: str

    @property
    def name(self) -> str:
        return f"{self.role}:{self.provider or '-'}:{self.model or '-'}"

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "provider": self.provider, "model": self.model}


@dataclass(frozen=True)
class PhaseRun:
    key: AgentKey
    run: AgentRun


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _read_logs(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        logger.debug("unreadable %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def task_log_files(project_dir: Path) -> list[Path]:
    """One ``task_logs.json`` per task: the copy updated last, project or worktree."""
    workpilot = Path(project_dir) / ".workpilot"
    candidates = list((workpilot / "specs").glob(f"*/{LOG_FILE}"))
    candidates += (workpilot / "worktrees" / "tasks").glob(
        f"*/.workpilot/specs/*/{LOG_FILE}"
    )
    latest: dict[str, tuple[str, Path]] = {}
    for path in candidates:
        data = _read_logs(path)
        if data is None:
            continue
        spec = path.parent.name
        updated = str(data.get("updated_at") or "")
        if spec not in latest or updated > latest[spec][0]:
            latest[spec] = (updated, path)
    return [path for _, path in sorted(latest.values(), key=lambda item: item[1])]


def _phase_key(role: str, entries: list[Any]) -> AgentKey:
    """The provider and model that wrote most of the phase's entries."""
    seen: Counter[tuple[str, str]] = Counter()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider") or "").strip()
        model = str(entry.get("model") or "").strip()
        if provider or model:
            seen[(provider, model)] += 1
    if not seen:
        return AgentKey(role, "", "")
    (provider, model), _ = seen.most_common(1)[0]
    return AgentKey(role, provider, model)


def phase_runs(data: dict[str, Any]) -> list[PhaseRun]:
    """The finished phases of one task, as runs of their agent."""
    phases = data.get("phases")
    if not isinstance(phases, dict):
        return []
    runs: list[PhaseRun] = []
    for phase_name, role in PHASE_ROLES.items():
        phase = phases.get(phase_name)
        if not isinstance(phase, dict):
            continue
        status = phase.get("status")
        if status not in FINISHED:
            continue
        entries = phase.get("entries")
        entries = entries if isinstance(entries, list) else []
        started = _parse_time(phase.get("started_at"))
        completed = _parse_time(phase.get("completed_at"))
        duration = 0.0
        if started and completed:
            duration = max(0.0, (completed - started).total_seconds())
        starts = sum(
            1 for e in entries if isinstance(e, dict) and e.get("type") == "phase_start"
        )
        errors = [
            str(e.get("content") or "")
            for e in entries
            if isinstance(e, dict) and e.get("type") == "error"
        ]
        when = started or completed
        runs.append(
            PhaseRun(
                key=_phase_key(role, entries),
                run=AgentRun(
                    agent_name="",
                    success=FINISHED[status],
                    duration_s=duration,
                    retries=max(0, starts - 1),
                    error=errors[-1][:MAX_ERROR_CHARS] if errors else "",
                    timestamp=when.timestamp() if when else 0.0,
                ),
            )
        )
    return runs


@dataclass
class ProjectHealth:
    scores: list[dict[str, Any]]
    pending: list[dict[str, Any]]
    tasks_read: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "scores": self.scores,
            "pending": self.pending,
            "tasks_read": self.tasks_read,
            "min_runs": HealthMonitor.MIN_RUNS_FOR_SCORING,
        }


def project_health(project_dir: Path) -> ProjectHealth:
    """Score every agent × provider × model that ran a phase of the project's tasks."""
    files = task_log_files(project_dir)
    collected: list[PhaseRun] = []
    for path in files:
        data = _read_logs(path)
        if data is not None:
            collected.extend(phase_runs(data))
    collected.sort(key=lambda r: r.run.timestamp)

    monitor = HealthMonitor()
    keys: dict[str, AgentKey] = {}
    for item in collected:
        keys[item.key.name] = item.key
        run = item.run
        monitor.record(
            AgentRun(
                agent_name=item.key.name,
                success=run.success,
                duration_s=run.duration_s,
                retries=run.retries,
                error=run.error,
                timestamp=run.timestamp,
            )
        )

    scores: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for name in monitor.known_agents():
        result = monitor.score(name)
        if result is None:
            runs = len(monitor._runs.get(name, ()))  # noqa: SLF001 — same package
            pending.append({**keys[name].to_dict(), "agent_name": name, "runs": runs})
        else:
            scores.append({**result.to_dict(), **keys[name].to_dict()})
    scores.sort(key=lambda s: s["score"])
    return ProjectHealth(scores=scores, pending=pending, tasks_read=len(files))
