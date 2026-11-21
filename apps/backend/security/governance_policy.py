"""The governance sections of ``workpilot.policy.yaml`` (#353, lots 2 and 3).

Beside its ``rules``, the repository's policy file may say four things about
every agent, on every provider:

.. code-block:: yaml

    version: 1
    schedule:
      timezone: Europe/Paris          # required: an IANA name, UTC or UTC+02:00
      allowed_hours: ["08:00-19:00"]  # windows; "22:00-06:00" runs overnight
      days: [mon, tue, wed, thu, fri] # optional, every day when absent
    files:
      forbidden: ["**/migrations/**", ".env*"]   # an agent never writes these
      requires_review: ["infra/**"]              # one-time approval first
    budget:
      max_tokens_per_hour: 500000     # every session of the project, last 60 min
      max_tokens_per_task: 2000000    # every session of one task, all along
    loop_detection:
      max_same_tool_call: 5           # identical calls before the breaker trips

Only the repository layer carries them: the file is versioned and reviewed like
code, and it is read from the main checkout, never from the task's worktree
where the agent could edit it (``guardrail_policy.main_project``).

Every key is checked, every number bounded. A section that does not hold
makes the whole policy invalid, and an invalid policy refuses every write and
command until it is fixed: a typo never turns a limit off in silence.

``files`` become ordinary guardrail rules (``deny`` / ``require_approval`` on a
path glob), judged where the other rules are. The schedule is judged before
every write or command by the same hook, and with the budget on the stream of
every session (``agents.policy_watch``), which pauses the task. The loop
limit replaces the circuit breaker's own (``agents.tool_breaker``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .guardrails import GuardrailAction, GuardrailRule, glob_to_regex

SECTIONS = ("schedule", "files", "budget", "loop_detection")

_SCHEDULE_KEYS = frozenset({"timezone", "allowed_hours", "days"})
_FILES_KEYS = frozenset({"forbidden", "requires_review"})
_BUDGET_KEYS = frozenset({"max_tokens_per_hour", "max_tokens_per_task"})
_LOOP_KEYS = frozenset({"max_same_tool_call"})

MAX_WINDOWS = 8
MAX_GLOBS = 200
MAX_GLOB_CHARS = 256
MIN_TOKENS_PER_HOUR = 1_000
MAX_TOKENS_PER_HOUR = 1_000_000_000
MIN_TOKENS_PER_TASK = 1_000
MAX_TOKENS_PER_TASK = 10_000_000_000
#: Fewer than 2 would stop an agent at its first call; past 100 nothing is caught.
MIN_SAME_TOOL_CALL = 2
MAX_SAME_TOOL_CALL = 100

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_FULL_DAYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
_DAY_NAMES = {name: i for names in (DAYS, _FULL_DAYS) for i, name in enumerate(names)}
_WINDOW = re.compile(r"^(\d{2}):(\d{2})-(\d{2}):(\d{2})$")
_OFFSET = re.compile(r"^UTC(?:([+-])(\d{2}):(\d{2}))?$")
_IANA = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$")

FORBIDDEN_PREFIX = "files.forbidden"
REVIEW_PREFIX = "files.requires_review"


@dataclass(frozen=True)
class Window:
    start: int  # minutes after midnight
    end: int  # minutes after midnight, 1440 for "24:00"; below start = overnight

    def label(self) -> str:
        return f"{self.start // 60:02d}:{self.start % 60:02d}-{self.end // 60:02d}:{self.end % 60:02d}"


@dataclass
class Governance:
    """What ``workpilot.policy.yaml`` says beyond its rules. Empty = no limit."""

    source: str = ""
    timezone: str | None = None
    windows: list[Window] = field(default_factory=list)
    days: tuple[int, ...] = tuple(range(7))
    forbidden: list[str] = field(default_factory=list)
    requires_review: list[str] = field(default_factory=list)
    max_tokens_per_hour: int | None = None
    max_tokens_per_task: int | None = None
    max_same_tool_call: int | None = None
    _zone: tzinfo | None = None

    @property
    def has_schedule(self) -> bool:
        return bool(self.windows)

    @property
    def active(self) -> bool:
        return bool(
            self.windows
            or self.forbidden
            or self.requires_review
            or self.max_tokens_per_hour
            or self.max_tokens_per_task
            or self.max_same_tool_call
        )

    def local(self, now: datetime | None = None) -> datetime:
        moment = now or datetime.now(UTC)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        return moment.astimezone(self._zone or UTC)

    def is_open(self, now: datetime | None = None) -> bool:
        """Whether agents may work at ``now`` (always, without a schedule)."""
        if not self.windows:
            return True
        local = self.local(now)
        minute = local.hour * 60 + local.minute
        today = local.weekday()
        yesterday = (today - 1) % 7
        for window in self.windows:
            if window.start < window.end:
                if today in self.days and window.start <= minute < window.end:
                    return True
            elif (minute >= window.start and today in self.days) or (
                minute < window.end and yesterday in self.days
            ):
                return True
        return False

    def file_rules(self) -> list[GuardrailRule]:
        """``files`` as guardrail rules, one per glob, judged with the others."""
        rules = []
        for prefix, globs, action, what in (
            (FORBIDDEN_PREFIX, self.forbidden, GuardrailAction.DENY, "forbids"),
            (
                REVIEW_PREFIX,
                self.requires_review,
                GuardrailAction.REQUIRE_APPROVAL,
                "needs a person's review for",
            ),
        ):
            for glob in globs:
                rules.append(
                    GuardrailRule(
                        id=f"{prefix}:{glob}",
                        description=f"workpilot.policy.yaml {what} files matching {glob}",
                        action=action,
                        path_glob=glob_to_regex(glob),
                        source=self.source,
                    )
                )
        return rules

    def to_dict(self, now: datetime | None = None) -> dict[str, Any]:
        return {
            "source": self.source,
            "schedule": {
                "timezone": self.timezone,
                "allowedHours": [w.label() for w in self.windows],
                "days": [DAYS[d] for d in self.days],
                "openNow": self.is_open(now),
                "localTime": self.local(now).isoformat() if self.windows else None,
            }
            if self.windows
            else None,
            "files": {
                "forbidden": list(self.forbidden),
                "requiresReview": list(self.requires_review),
            },
            "budget": {
                "maxTokensPerHour": self.max_tokens_per_hour,
                "maxTokensPerTask": self.max_tokens_per_task,
            }
            if self.max_tokens_per_hour or self.max_tokens_per_task
            else None,
            "loopDetection": {"maxSameToolCall": self.max_same_tool_call}
            if self.max_same_tool_call
            else None,
        }


def _zone(name: Any, errors: list[str], label: str) -> tzinfo | None:
    if not isinstance(name, str) or not name.strip():
        errors.append(
            f"{label}: 'schedule.timezone' is required (an IANA name such as "
            "Europe/Paris, or UTC, or UTC+02:00)"
        )
        return None
    name = name.strip()
    offset = _OFFSET.match(name)
    if offset:
        if offset.group(1) is None:
            return UTC
        hours, minutes = int(offset.group(2)), int(offset.group(3))
        if hours > 14 or minutes > 59:
            errors.append(f"{label}: time zone '{name}' is out of range")
            return None
        delta = timedelta(hours=hours, minutes=minutes)
        return timezone(delta if offset.group(1) == "+" else -delta)
    if len(name) > 64 or not _IANA.match(name):
        errors.append(f"{label}: '{name[:64]}' is not a time zone name")
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        errors.append(
            f"{label}: time zone '{name}' is unknown on this machine; write it as "
            "an offset such as UTC+01:00, or install the time zone data"
        )
        return None


def _windows(raw: Any, errors: list[str], label: str) -> list[Window]:
    if not isinstance(raw, list) or not raw:
        errors.append(
            f"{label}: 'schedule.allowed_hours' must be a list of 'HH:MM-HH:MM' windows"
        )
        return []
    if len(raw) > MAX_WINDOWS:
        errors.append(f"{label}: at most {MAX_WINDOWS} windows in 'allowed_hours'")
        return []
    windows = []
    for item in raw:
        match = _WINDOW.match(item.strip()) if isinstance(item, str) else None
        if not match:
            errors.append(f"{label}: '{str(item)[:40]}' is not an 'HH:MM-HH:MM' window")
            continue
        sh, sm, eh, em = (int(g) for g in match.groups())
        start, end = sh * 60 + sm, eh * 60 + em
        if sh > 23 or sm > 59 or em > 59 or end > 1440 or start == end:
            errors.append(f"{label}: '{item}' is not a valid window")
            continue
        windows.append(Window(start, end))
    return windows


def _days(raw: Any, errors: list[str], label: str) -> tuple[int, ...]:
    if raw is None:
        return tuple(range(7))
    if not isinstance(raw, list) or not raw:
        errors.append(f"{label}: 'schedule.days' must be a list such as [mon, tue]")
        return tuple(range(7))
    found: set[int] = set()
    for item in raw:
        day = _DAY_NAMES.get(item.strip().lower()) if isinstance(item, str) else None
        if day is None:
            errors.append(f"{label}: '{str(item)[:20]}' is not a day (mon … sun)")
            continue
        found.add(day)
    return tuple(sorted(found)) or tuple(range(7))


def _globs(raw: Any, key: str, errors: list[str], label: str) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors.append(f"{label}: 'files.{key}' must be a list of globs")
        return []
    if len(raw) > MAX_GLOBS:
        errors.append(f"{label}: at most {MAX_GLOBS} globs in 'files.{key}'")
        return []
    globs: list[str] = []
    for item in raw:
        text = item.strip() if isinstance(item, str) else ""
        normalized = text.replace("\\", "/")
        if (
            not text
            or len(text) > MAX_GLOB_CHARS
            or normalized.startswith("/")
            or re.match(r"^[A-Za-z]:", normalized)
            or ".." in normalized.split("/")
            or any(ord(c) < 32 for c in text)
        ):
            errors.append(
                f"{label}: '{str(item)[:60]}' in 'files.{key}' is not a glob relative "
                "to the repository"
            )
            continue
        globs.append(normalized.removeprefix("./"))
    return globs


def _section(
    data: dict[str, Any], key: str, known: frozenset[str], errors: list[str], label: str
) -> dict[str, Any]:
    raw = data.get(key)
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        errors.append(f"{label}: '{key}' must be a mapping")
        return {}
    for unknown in sorted(set(raw) - known):
        errors.append(f"{label}: unknown key '{key}.{unknown}'")
    return raw


def _bounded(
    section: dict[str, Any],
    dotted: str,
    bounds: tuple[int, int],
    errors: list[str],
    label: str,
) -> int | None:
    """A whole number of ``section`` within ``bounds``; ``None`` when absent or wrong."""
    key = dotted.rsplit(".", 1)[1]
    if key not in section:
        return None
    value = section[key]
    low, high = bounds
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not low <= value <= high
    ):
        errors.append(
            f"{label}: '{dotted}' must be a whole number from {low:,} to {high:,}"
        )
        return None
    return value


def parse_governance(
    data: dict[str, Any], label: str, source: str = ""
) -> tuple[Governance, list[str]]:
    """The governance sections of one policy document, and what is wrong with them."""
    errors: list[str] = []
    governance = Governance(source=source)

    schedule = _section(data, "schedule", _SCHEDULE_KEYS, errors, label)
    if schedule:
        zone = _zone(schedule.get("timezone"), errors, label)
        windows = _windows(schedule.get("allowed_hours"), errors, label)
        days = _days(schedule.get("days"), errors, label)
        if zone is not None and windows:
            governance.timezone = str(schedule.get("timezone")).strip()
            governance._zone = zone
            governance.windows = windows
            governance.days = days

    files = _section(data, "files", _FILES_KEYS, errors, label)
    governance.forbidden = _globs(files.get("forbidden"), "forbidden", errors, label)
    governance.requires_review = _globs(
        files.get("requires_review"), "requires_review", errors, label
    )

    budget = _section(data, "budget", _BUDGET_KEYS, errors, label)
    governance.max_tokens_per_hour = _bounded(
        budget,
        "budget.max_tokens_per_hour",
        (MIN_TOKENS_PER_HOUR, MAX_TOKENS_PER_HOUR),
        errors,
        label,
    )
    governance.max_tokens_per_task = _bounded(
        budget,
        "budget.max_tokens_per_task",
        (MIN_TOKENS_PER_TASK, MAX_TOKENS_PER_TASK),
        errors,
        label,
    )
    loop = _section(data, "loop_detection", _LOOP_KEYS, errors, label)
    governance.max_same_tool_call = _bounded(
        loop,
        "loop_detection.max_same_tool_call",
        (MIN_SAME_TOOL_CALL, MAX_SAME_TOOL_CALL),
        errors,
        label,
    )
    return governance, errors


def schedule_refusal(
    governance: Governance | None, now: datetime | None = None
) -> str | None:
    """Why no write or command may run now, or ``None`` inside the allowed hours."""
    if governance is None or governance.is_open(now):
        return None
    local = governance.local(now)
    days = ", ".join(DAYS[d] for d in governance.days)
    return (
        f"Outside the hours workpilot.policy.yaml allows agents to work "
        f"({', '.join(w.label() for w in governance.windows)} {governance.timezone}, "
        f"{days}; it is {local:%a %H:%M} there). The task is paused; it can be "
        "resumed inside the allowed hours."
    )


__all__ = [
    "FORBIDDEN_PREFIX",
    "Governance",
    "REVIEW_PREFIX",
    "SECTIONS",
    "Window",
    "parse_governance",
    "schedule_refusal",
]
