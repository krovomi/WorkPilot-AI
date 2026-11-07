"""A periodic digest of a long task, on the notification channels (lot 6, P1).

Agents now work on tasks that last hours, soon days. A person does not follow
such a task by reading its logs: every few hours, the channels the project
already uses for "PR ready" (Teams, Slack, Discord, Google Chat, a webhook)
get a short digest of where the task is: subtasks done out of planned, what
is running, what is blocked and why, the QA pass.

Off unless asked: ``WORKPILOT_TASK_DIGEST_HOURS`` (0.25 to 168) sets the
interval, and nothing is sent without a configured channel. The first digest
comes one interval after the build started, so a short task never sends one.
The time of the last digest is kept in the spec folder: a build resumed after
a restart waits for the rest of the interval, it does not send at once.

What goes out is read from the task's own files (the plan and its sign-off),
cut short, and never includes code, a diff or a log line.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from foundation.subtask_unblock import blocked_reason

from .channels import _get_app_language, build_text_payload, post_json
from .models import ChannelResult, NotificationChannel
from .service import NotificationService, _parse_env_file

logger = logging.getLogger(__name__)

__all__ = [
    "DIGEST_ENV",
    "TaskDigest",
    "build_digest",
    "digest_interval_seconds",
    "render_digest",
    "start_digest_heartbeat",
]

DIGEST_ENV = "WORKPILOT_TASK_DIGEST_HOURS"
STATE_FILE = "digest_state.json"
MIN_HOURS, MAX_HOURS = 0.25, 168.0
_TITLE_MAX = 120
_REASON_MAX = 160
_LISTED = 3

_STRINGS = {
    "en": {
        "head": "⏱ {title}: {elapsed} in",
        "progress": "Subtasks: {done}/{total} done",
        "running": "Running: {items}",
        "blocked": "Blocked: {items}",
        "qa": "QA: pass {iteration}, {status}",
        "nothing": "No subtask moved since the last digest.",
        "no_plan": "No plan yet: the task is still being planned.",
    },
    "fr": {
        "head": "⏱ {title} : en cours depuis {elapsed}",
        "progress": "Sous-tâches : {done}/{total} terminées",
        "running": "En cours : {items}",
        "blocked": "Bloquées : {items}",
        "qa": "QA : passe {iteration}, {status}",
        "nothing": "Aucune sous-tâche n'a bougé depuis le dernier point.",
        "no_plan": "Pas encore de plan : la tâche est en cours de planification.",
    },
}


def _strings() -> dict[str, str]:
    return _STRINGS.get(_get_app_language(), _STRINGS["en"])


def _short(text: object, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


@dataclass
class TaskDigest:
    title: str
    done: int = 0
    total: int = 0
    running: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    qa_iteration: int | None = None
    qa_status: str = ""

    @property
    def fingerprint(self) -> str:
        return json.dumps(
            [self.done, self.total, self.running, self.blocked, self.qa_status]
        )

    def as_event(self) -> dict:
        return {
            "event": "task_digest",
            "task_title": self.title,
            "subtasks_done": self.done,
            "subtasks_total": self.total,
            "running": self.running,
            "blocked": self.blocked,
            "qa_iteration": self.qa_iteration,
            "qa_status": self.qa_status,
        }


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _title(spec_dir: Path, plan: dict) -> str:
    for candidate in (
        plan.get("feature"),
        plan.get("title"),
        _read_json(spec_dir / "requirements.json").get("task_description"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return _short(candidate, _TITLE_MAX)
    return spec_dir.name


def build_digest(spec_dir: Path | str) -> TaskDigest:
    """Where the task is, from its plan and its QA sign-off."""
    spec_dir = Path(spec_dir)
    plan = _read_json(spec_dir / "implementation_plan.json")
    digest = TaskDigest(title=_title(spec_dir, plan))
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks") or []:
            if not isinstance(subtask, dict):
                continue
            digest.total += 1
            status = subtask.get("status")
            name = _short(subtask.get("description") or subtask.get("id"), _TITLE_MAX)
            if status == "completed":
                digest.done += 1
            elif status == "in_progress":
                digest.running.append(name)
            elif status in ("blocked", "failed"):
                reason = _short(blocked_reason(subtask), _REASON_MAX)
                digest.blocked.append(f"{name} ({reason})" if reason else name)
    signoff = plan.get("qa_signoff")
    if isinstance(signoff, dict) and signoff.get("status"):
        digest.qa_status = _short(signoff.get("status"), 40)
        iteration = signoff.get("qa_session") or signoff.get("iteration")
        digest.qa_iteration = iteration if isinstance(iteration, int) else None
    return digest


def _elapsed(seconds: float) -> str:
    hours, rest = divmod(int(seconds), 3600)
    days, hours = divmod(hours, 24)
    minutes = rest // 60
    if days:
        return f"{days} d {hours} h"
    return f"{hours} h {minutes:02d}" if hours else f"{minutes} min"


def render_digest(digest: TaskDigest, elapsed_seconds: float, *, moved: bool) -> str:
    s = _strings()
    lines = [s["head"].format(title=digest.title, elapsed=_elapsed(elapsed_seconds))]
    if digest.total == 0:
        lines.append(s["no_plan"])
    else:
        lines.append(s["progress"].format(done=digest.done, total=digest.total))
    if digest.running:
        lines.append(s["running"].format(items="; ".join(digest.running[:_LISTED])))
    if digest.blocked:
        lines.append(s["blocked"].format(items="; ".join(digest.blocked[:_LISTED])))
    if digest.qa_status:
        lines.append(
            s["qa"].format(
                iteration=digest.qa_iteration or "?", status=digest.qa_status
            )
        )
    if not moved and digest.total:
        lines.append(s["nothing"])
    return "\n".join(lines)


def digest_interval_seconds(project_dir: Path | str | None = None) -> float | None:
    """The interval asked for, or None when the digest is off.

    The process environment wins over the project's `.workpilot/.env`, as
    for the channels themselves.
    """
    raw = os.environ.get(DIGEST_ENV, "").strip()
    if not raw and project_dir is not None:
        env_file = Path(project_dir) / ".workpilot" / ".env"
        if env_file.is_file():
            raw = _parse_env_file(env_file).get(DIGEST_ENV, "").strip()
    if not raw:
        return None
    try:
        hours = float(raw)
    except ValueError:
        logger.warning("[Digest] %s=%r is not a number: digest off", DIGEST_ENV, raw)
        return None
    if hours <= 0:
        return None
    return min(max(hours, MIN_HOURS), MAX_HOURS) * 3600


def _state_path(spec_dir: Path) -> Path:
    return spec_dir / "memory" / STATE_FILE


def _load_state(spec_dir: Path) -> dict:
    return _read_json(_state_path(spec_dir))


def _save_state(spec_dir: Path, state: dict) -> None:
    path = _state_path(spec_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _send(
    service: NotificationService, text: str, digest: TaskDigest
) -> list[ChannelResult]:
    results: list[ChannelResult] = []
    for config in service.channels:
        payload = (
            {**digest.as_event(), "message": text}
            if config.channel == NotificationChannel.WEBHOOK
            else build_text_payload(config.channel, text)
        )
        try:
            ok, code, error = post_json(config.webhook_url, payload)
        except (OSError, ValueError) as exc:
            ok, code, error = False, None, type(exc).__name__
        results.append(ChannelResult(config.channel, ok, code, error))
    return results


@dataclass
class _Heartbeat:
    spec_dir: Path
    interval: float
    service: NotificationService
    clock: Callable[[], float] = time.time
    stop: threading.Event = field(default_factory=threading.Event)

    def due_in(self) -> float:
        """Seconds until the next digest, from the state the spec folder keeps."""
        state = _load_state(self.spec_dir)
        now = self.clock()
        started = state.get("started_at")
        if not isinstance(started, (int, float)):
            started = now
            _save_state(self.spec_dir, {**state, "started_at": started})
        last = state.get("last_sent_at")
        anchor = last if isinstance(last, (int, float)) else started
        return max(0.0, anchor + self.interval - now)

    def tick(self) -> bool:
        """Send one digest; whether a channel took it."""
        state = _load_state(self.spec_dir)
        now = self.clock()
        digest = build_digest(self.spec_dir)
        moved = digest.fingerprint != state.get("fingerprint")
        started = state.get("started_at", now)
        text = render_digest(digest, now - started, moved=moved)
        results = _send(self.service, text, digest)
        _save_state(
            self.spec_dir,
            {**state, "last_sent_at": now, "fingerprint": digest.fingerprint},
        )
        delivered = any(r.success for r in results)
        if not delivered:
            logger.warning(
                "[Digest] no channel accepted the digest of %s", self.spec_dir.name
            )
        return delivered

    def run(self) -> None:
        while not self.stop.wait(self.due_in()):
            try:
                self.tick()
            except OSError as exc:
                logger.warning("[Digest] could not send: %s", exc)
                if self.stop.wait(60):
                    return


def start_digest_heartbeat(
    spec_dir: Path | str,
    project_dir: Path | str,
    *,
    clock: Callable[[], float] = time.time,
) -> threading.Event | None:
    """Start the digest of this build; the event stops it. None when off.

    A daemon thread: it ends with the build's process, and never holds it up.
    """
    interval = digest_interval_seconds(project_dir)
    if interval is None:
        return None
    service = NotificationService.from_env(project_dir)
    if not service.is_configured:
        logger.info(
            "[Digest] %s is set but no notification channel is configured", DIGEST_ENV
        )
        return None
    beat = _Heartbeat(Path(spec_dir), interval, service, clock)
    try:
        beat.due_in()  # records when the build started, before the first wait
    except OSError as exc:
        logger.warning("[Digest] off: the spec folder is not writable (%s)", exc)
        return None
    thread = threading.Thread(target=beat.run, name="task-digest", daemon=True)
    thread.start()
    logger.info(
        "[Digest] every %.2f h for %s (%s)",
        interval / 3600,
        Path(spec_dir).name,
        datetime.now(UTC).isoformat(timespec="seconds"),
    )
    return beat.stop
