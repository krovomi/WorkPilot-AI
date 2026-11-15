"""The reinforced sandbox and the anomaly watch, around one agent session.

Built by ``agents.session_guards`` at the start of every session, beside the
tool-call circuit breaker, so it sees what the breaker sees: every tool call
and its result, for every provider (the Claude SDK, the CLI agents, the ACP
agents, WorkPilot's own loop).

At the start
    In a task worktree, a git snapshot of the worktree (``agent_snapshots``):
    the state the session can be rolled back to.

On each result
    The call becomes detector events (``agents.safety_events``) and the
    session's trust score (``security.anomaly_detector``) drops with each
    anomaly. Below the pause threshold the task is paused (``reason:
    anomaly``); below the stop threshold it is paused too, and the snapshot is
    restored when the session ends (on by default). The sandbox's own limits
    are counted here for every provider: a write outside the restricted paths
    or over the size limit (which the hooks refuse first where they exist,
    so this catches the CLI agents' own tools) stops the session and restores
    the snapshot; too many files written, or a session over its time limit,
    pauses it (``reason: sandbox``).

The pause is ``foundation.pause_state.pause_task``, the one the breaker and the
budgets use: the coder, the QA and the spec read it at their next checkpoint
and raise ``BuildPaused``. Nothing here raises into the session.
"""

from __future__ import annotations

import json
import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agent_snapshots import SnapshotError, create_snapshot, rollback, task_worktree
from foundation.pause_state import pause_task, task_spec_dirs
from security.agent_safety_settings import AgentSafetySettings, load_settings
from security.anomaly_detector import AnomalyDetector
from security.sandbox import SandboxPolicy, path_allowed, project_relative

from .safety_events import call_events, written_path

logger = logging.getLogger(__name__)

ANOMALY_REASON = "anomaly"
SANDBOX_REASON = "sandbox"
REPORT_FILE = "agent_safety.json"
#: Sessions kept in the report.
REPORT_SESSIONS = 20

_PAUSE_PHASE = {"planning": "planning", "coding": "coding", "validation": "qa_review"}


def _project_of(spec_dir: Path) -> Path | None:
    """The project a spec directory sits in (``<project>/.workpilot/specs/<t>``)."""
    parts = spec_dir.resolve().parts
    if ".workpilot" in parts[1:]:
        return Path(*parts[: len(parts) - 1 - parts[::-1].index(".workpilot")])
    return None


class SafetyWatch:
    """Snapshot, trust score and sandbox limits of one session."""

    def __init__(
        self,
        spec_dir: Path | str,
        phase: str,
        settings: AgentSafetySettings | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.spec_dir = Path(spec_dir)
        self.phase = _PAUSE_PHASE.get(str(phase), "coding")
        self.settings = settings or load_settings()
        self.policy = SandboxPolicy.from_settings(self.settings.sandbox)
        self._clock = clock
        self._started = clock()
        self.started_at = datetime.now(UTC).isoformat()
        self.tripped = False
        self.stop = False
        self.reason: str | None = None
        self.detail: dict[str, Any] = {}
        self.rolled_back: dict[str, str] | None = None
        self._pending: dict[str, tuple[str, Any]] = {}
        self._order: deque[tuple[str, Any]] = deque()
        self._written: set[str] = set()

        located = task_worktree(self.spec_dir)
        self.worktree, self.task = located if located else (None, None)
        self.project_dir = self.worktree or _project_of(self.spec_dir)

        self.snapshot_id: str | None = None
        if located and self.settings.snapshots.enabled:
            self._take_snapshot()

        self.detector: AnomalyDetector | None = None
        self.session_id: str | None = None
        if self.settings.anomaly.enabled:
            self.detector = AnomalyDetector(
                thresholds=self.settings.anomaly.thresholds()
            )
            session = self.detector.start_session(
                task_id=self.task or self.spec_dir.name, agent_type=self.phase
            )
            self.session_id = session.session_id

    # -- the stream -----------------------------------------------------------

    def _take_snapshot(self) -> None:
        assert self.worktree is not None and self.task is not None
        try:
            snapshot = create_snapshot(
                self.worktree,
                self.task,
                label=self.phase,
                keep=self.settings.snapshots.keep,
            )
        except (SnapshotError, OSError) as exc:
            logger.warning("Snapshot before the session skipped: %s", exc)
            return
        self.snapshot_id = snapshot.snapshot_id

    def call(self, name: str, arguments: Any, call_id: str | None = None) -> None:
        entry = (name or "", arguments if arguments is not None else {})
        if call_id:
            self._pending[call_id] = entry
        else:
            self._order.append(entry)
        self._check_time()

    def _take(self, call_id: str | None) -> tuple[str, Any] | None:
        if call_id and call_id in self._pending:
            return self._pending.pop(call_id)
        if self._order:
            return self._order.popleft()
        if self._pending:
            return self._pending.pop(next(iter(self._pending)))
        return None

    def result(self, content: Any, is_error: bool, call_id: str | None = None) -> bool:
        """The result of a call. True once, when it stops the session."""
        entry = self._take(call_id)
        if entry is None or self.tripped:
            return False
        name, arguments = entry
        self._score(name, arguments, bool(is_error))
        if not self.tripped and not is_error:
            self._check_write(name, arguments)
        if not self.tripped:
            self._check_time()
        return self.tripped

    def _score(self, name: str, arguments: Any, is_error: bool) -> None:
        if self.detector is None or self.session_id is None:
            return
        events = call_events(name, arguments, self.project_dir)
        if is_error:
            events.append(("error", {"tool": name}))
        session = self.detector.get_session(self.session_id)
        for event_type, metadata in events:
            if session.status != "active":
                break
            self.detector.record_event(self.session_id, event_type, metadata)
        if session.status in ("paused", "terminated"):
            stopped = session.status == "terminated"
            anomalies = [
                {
                    "type": a.anomaly_type,
                    "severity": a.severity,
                    "description": a.description[:300],
                }
                for a in session.anomalies[-10:]
            ]
            self._trip(
                ANOMALY_REASON,
                {
                    "trustScore": round(session.trust_score, 1),
                    "pauseBelow": self.settings.anomaly.pause_below,
                    "stopBelow": self.settings.anomaly.stop_below,
                    "stopped": stopped,
                    "anomalies": anomalies,
                },
                stop=stopped,
            )

    def _check_write(self, name: str, arguments: Any) -> None:
        target = written_path(name, arguments)
        if not target:
            return
        relative = project_relative(target, self.project_dir)
        if relative is None:
            return
        if (
            self.policy.restricted
            and not relative.startswith(".workpilot")
            and not path_allowed(relative, self.policy.allowed_paths)
        ):
            self._trip(
                SANDBOX_REASON,
                {"kind": "restricted_path", "path": relative},
                stop=True,
            )
            return
        if self.policy.max_file_bytes and self.project_dir is not None:
            try:
                size = (self.project_dir / relative).stat().st_size
            except OSError:
                size = 0
            if size > self.policy.max_file_bytes:
                self._trip(
                    SANDBOX_REASON,
                    {
                        "kind": "file_size",
                        "path": relative,
                        "value": size,
                        "limit": self.policy.max_file_bytes,
                    },
                    stop=True,
                )
                return
        self._written.add(relative)
        limit = self.policy.max_files_written
        if limit and len(self._written) > limit:
            self._trip(
                SANDBOX_REASON,
                {"kind": "files_written", "value": len(self._written), "limit": limit},
                stop=False,
            )

    def _check_time(self) -> None:
        limit = self.policy.max_session_seconds
        if self.tripped or not limit:
            return
        elapsed = self._clock() - self._started
        if elapsed > limit:
            self._trip(
                SANDBOX_REASON,
                {"kind": "session_time", "value": int(elapsed), "limit": limit},
                stop=False,
            )

    # -- stopping -------------------------------------------------------------

    def _trip(self, reason: str, detail: dict[str, Any], *, stop: bool) -> None:
        self.tripped = True
        self.stop = stop
        self.reason = reason
        self.detail = {
            **detail,
            "phase": self.phase,
            "snapshotId": self.snapshot_id,
            "rollback": stop
            and self.snapshot_id is not None
            and self.settings.snapshots.auto_rollback,
        }
        what = "anomaly watch" if reason == ANOMALY_REASON else "sandbox"
        logger.warning("The %s stopped the session: %s", what, detail)
        print(
            f"\n[{what.capitalize()}] the session is stopped and the task paused: "
            f"{json.dumps(detail, default=str)[:400]}",
            flush=True,
        )
        self._write_pause()

    def _write_pause(self) -> None:
        # Only after a trip, which names the reason.
        assert self.reason is not None
        pause_task(
            self.spec_dir,
            phase=self.phase,
            reason=self.reason,
            detail={self.reason: self.detail},
        )

    def close(self) -> None:
        """The session is over: restore the snapshot if it was stopped, report."""
        if self.detector is not None and self.session_id is not None:
            session = self.detector.get_session(self.session_id)
            if session.status == "active":
                self.detector.end_session(self.session_id)
        if self.detail.get("rollback") and self.rolled_back is None:
            self._rollback()
        self._report()

    def _rollback(self) -> None:
        # Due only when a snapshot was taken, so in a task worktree.
        assert self.worktree and self.task and self.snapshot_id
        try:
            self.rolled_back = rollback(self.worktree, self.task, self.snapshot_id)
        except (SnapshotError, OSError) as exc:
            logger.error("Rollback to %s failed: %s", self.snapshot_id, exc)
            self.detail["rollbackError"] = str(exc)[:300]
        else:
            self.detail["rolledBack"] = True
            self.detail["safetySnapshotId"] = self.rolled_back["safety"]
            print(
                f"\n[Sandbox] the worktree is back to snapshot {self.snapshot_id}; "
                f"the state it replaced is snapshot {self.rolled_back['safety']}.",
                flush=True,
            )
        self._write_pause()

    def _report(self) -> None:
        entry: dict[str, Any] = {
            "phase": self.phase,
            "startedAt": self.started_at,
            "endedAt": datetime.now(UTC).isoformat(),
            "snapshotId": self.snapshot_id,
            "outcome": self.reason or "completed",
            "filesWritten": len(self._written),
        }
        if self.detector is not None and self.session_id is not None:
            session = self.detector.get_session(self.session_id)
            entry["trustScore"] = round(session.trust_score, 1)
            entry["anomalies"] = [a.anomaly_type for a in session.anomalies][:20]
        if self.rolled_back:
            entry["rolledBack"] = self.rolled_back
        for folder in task_spec_dirs(self.spec_dir):
            path = folder / REPORT_FILE
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
                sessions = previous.get("sessions", [])
                if not isinstance(sessions, list):
                    sessions = []
            except (OSError, ValueError, AttributeError):
                sessions = []
            sessions = [*sessions, entry][-REPORT_SESSIONS:]
            try:
                path.write_text(
                    json.dumps({"sessions": sessions}, indent=2), encoding="utf-8"
                )
            except OSError:
                # The report is a record: losing it never fails the session.
                pass


__all__ = ["ANOMALY_REASON", "REPORT_FILE", "SANDBOX_REASON", "SafetyWatch"]
