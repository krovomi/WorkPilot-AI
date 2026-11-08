"""Automation rules as the server accepts them: the desktop's rules.

The same schema, the same closed lists and the same bounds as
``apps/frontend/src/main/automations/rules.ts``, which a test reads to keep
the two equal. A rule arrives from a client, which is not trusted: every
field is checked here and anything else is refused with a reason.
"""

from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from typing import Any

MAX_RULES = 20
DEFAULT_DAILY_CAP = 3
MAX_DAILY_CAP = 20

RULE_ID = re.compile(r"^r-[a-f0-9]{12}$")
PROVIDER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
EFFORTS = ("none", "low", "medium", "high", "ultrathink")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
#: GitHub refuses labels over 50 characters; git refs have their own grammar.
LABEL_MAX = 50
BRANCH = re.compile(r"^(?!.*\.\.)(?!/)(?!.*/$)[A-Za-z0-9._/-]{1,200}$")
#: ``TASK_KINDS`` of ``shared/types/task.ts``.
TASK_KINDS = (
    "feature",
    "bug_fix",
    "hotfix",
    "investigation",
    "run",
    "refactoring",
    "test",
    "docs",
    "spike",
    "upgrade",
)
TRIGGERS = ("issue_labeled", "ci_failed", "schedule", "pr_opened")


class RuleError(ValueError):
    """A rule refused, with the reason the client is told."""


def new_rule_id() -> str:
    return f"r-{secrets.token_hex(6)}"


def is_rule_id(value: Any) -> bool:
    return isinstance(value, str) and RULE_ID.match(value) is not None


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed or len(trimmed) > limit:
        return None
    # Control characters other than newlines and tabs have no business in a rule.
    if any(ord(c) < 32 and c not in "\n\t" for c in trimmed):
        return None
    return trimmed


def _single_line(value: Any, limit: int) -> str | None:
    result = _text(value, limit)
    return result if result and "\n" not in result and "\t" not in result else None


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _trigger(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RuleError("A rule needs a trigger")
    kind = raw.get("type")
    if kind == "issue_labeled":
        label = _single_line(raw.get("label"), LABEL_MAX)
        if not label:
            raise RuleError("The trigger needs a label")
        # The issue list takes labels comma-separated: a comma would be two labels.
        if "," in label:
            raise RuleError("A label cannot contain a comma")
        return {"type": kind, "label": label}
    if kind == "ci_failed":
        branch = raw.get("branch")
        if branch is None or branch == "":
            return {"type": kind}
        if not isinstance(branch, str) or not BRANCH.match(branch):
            raise RuleError("The trigger's branch is not a branch name")
        return {"type": kind, "branch": branch}
    if kind == "schedule":
        time = raw.get("time")
        if not isinstance(time, str) or not TIME.match(time):
            raise RuleError("The schedule needs a time as HH:MM")
        days = raw.get("days")
        if (
            not isinstance(days, list)
            or not days
            or any(not _integer(d) or d < 0 or d > 6 for d in days)
        ):
            raise RuleError("The schedule needs at least one day of the week")
        title = _single_line(raw.get("title"), 200)
        if not title:
            raise RuleError("The schedule needs a card title")
        prompt = _text(raw.get("prompt"), 10_000)
        if not prompt:
            raise RuleError("The schedule needs a description for its card")
        return {
            "type": kind,
            "time": time,
            "days": sorted(set(days)),
            "title": title,
            "prompt": prompt,
        }
    if kind == "pr_opened":
        base = raw.get("base")
        if base is None or base == "":
            return {"type": kind}
        if not isinstance(base, str) or not BRANCH.match(base):
            raise RuleError("The trigger's base branch is not a branch name")
        return {"type": kind, "base": base}
    raise RuleError("Unknown trigger")


def _engine(raw: Any) -> dict[str, str] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RuleError("The engine must be an object")
    provider = raw.get("provider")
    if not isinstance(provider, str) or not PROVIDER.match(provider):
        raise RuleError("The engine has no valid provider")
    model = _single_line(raw.get("model"), 200)
    if not model:
        raise RuleError("The engine has no valid model")
    effort = raw.get("effort")
    if effort not in EFFORTS:
        raise RuleError("The engine has no valid effort")
    return {"provider": provider, "model": model, "effort": effort}


def parse_rule(
    raw: Any, existing: dict[str, Any] | None = None, now: datetime | None = None
) -> dict[str, Any]:
    """The rule a client sent, checked. ``existing`` is the stored rule with
    the same id, whose ``createdAt`` a save keeps: moving it would make old
    events new. Raises :class:`RuleError`."""
    if not isinstance(raw, dict):
        raise RuleError("A rule must be an object")
    name = _single_line(raw.get("name"), 80)
    if not name:
        raise RuleError("A rule needs a name")
    trigger = _trigger(raw.get("trigger"))
    kind = raw.get("kind")
    if kind in (None, ""):
        kind = None
    elif kind not in TASK_KINDS:
        raise RuleError("Unknown card kind")
    engine = _engine(raw.get("engine"))
    cap = raw.get("dailyCap", DEFAULT_DAILY_CAP)
    if cap is None:
        cap = DEFAULT_DAILY_CAP
    if not _integer(cap) or cap < 1 or cap > MAX_DAILY_CAP:
        raise RuleError(f"The daily cap is between 1 and {MAX_DAILY_CAP}")
    if existing and existing["trigger"]["type"] != trigger["type"]:
        # A new kind of event is a new rule: its history says nothing about it.
        raise RuleError("A rule keeps its trigger type; create another rule instead")
    # A PR rule makes no card: it starts the review, and its result is a draft.
    review = trigger["type"] == "pr_opened"
    rule: dict[str, Any] = {
        "id": existing["id"] if existing else new_rule_id(),
        "name": name,
        "enabled": raw.get("enabled") is not False,
        "trigger": trigger,
    }
    if kind and not review:
        rule["kind"] = kind
    if engine and not review:
        rule["engine"] = engine
    # Draft unless the person turned it off, explicitly.
    rule["draft"] = review or raw.get("draft") is not False
    rule["dailyCap"] = cap
    rule["createdAt"] = (
        existing["createdAt"]
        if existing
        else (now or datetime.now(UTC)).isoformat().replace("+00:00", "Z")
    )
    return rule


def _iso(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def parse_stored_rule(raw: Any) -> dict[str, Any] | None:
    """A rule read back from the database: the same checks, its identity kept."""
    if not isinstance(raw, dict):
        return None
    if not is_rule_id(raw.get("id")) or not _iso(raw.get("createdAt")):
        return None
    try:
        parsed = parse_rule(raw)
    except RuleError:
        return None
    return {**parsed, "id": raw["id"], "createdAt": raw["createdAt"]}


def created_at(rule: dict[str, Any]) -> datetime:
    """The rule's creation time, aware."""
    moment = datetime.fromisoformat(str(rule["createdAt"]).replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)
