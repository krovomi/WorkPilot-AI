"""Where a server project's automations live: one row of
``project_automations``, the desktop's ``rules.json`` and ``ledger.json``
side by side, with who saved each rule.

A save and a pass of the same project do not interleave: both hold the
project's lock while they read and write the row.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from server.db.models import ProjectAutomation
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from .rules import parse_stored_rule

MAX_SEEN = 2000
MAX_ACTIVITY = 100

_locks: dict[str, asyncio.Lock] = {}


def project_lock(project_id: str) -> asyncio.Lock:
    """The lock a save and a pass of ``project_id`` hold."""
    lock = _locks.get(project_id)
    if lock is None:
        lock = _locks[project_id] = asyncio.Lock()
    return lock


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def empty_ledger() -> dict[str, Any]:
    return {"seen": {}, "created": {}, "openCi": {}, "statuses": {}, "activity": []}


def normalize_ledger(raw: Any) -> dict[str, Any]:
    ledger = _record(raw)
    activity = ledger.get("activity")
    return {
        "seen": dict(_record(ledger.get("seen"))),
        "created": dict(_record(ledger.get("created"))),
        "openCi": dict(_record(ledger.get("openCi"))),
        "statuses": dict(_record(ledger.get("statuses"))),
        "activity": list(activity) if isinstance(activity, list) else [],
    }


def trim_ledger(ledger: dict[str, Any]) -> dict[str, Any]:
    """The oldest seen events and activity lines go first, as on the desktop."""
    seen = list(ledger["seen"].items())
    if len(seen) > MAX_SEEN:
        seen.sort(key=lambda item: str(_record(item[1]).get("at", "")))
        ledger["seen"] = dict(seen[len(seen) - MAX_SEEN :])
    ledger["activity"] = ledger["activity"][-MAX_ACTIVITY:]
    return ledger


def forget_rule(ledger: dict[str, Any], rule_id: str) -> None:
    """A rule's history goes with it: a new rule with the same name starts clean."""
    ledger["seen"] = {
        key: event
        for key, event in ledger["seen"].items()
        if _record(event).get("ruleId") != rule_id
    }
    for part in ("created", "openCi", "statuses"):
        ledger[part].pop(rule_id, None)


def keep_rules(ledger: dict[str, Any], rule_ids: set[str]) -> None:
    """Drop the history of rules deleted while a pass ran."""
    for rule_id in {
        *ledger["created"],
        *ledger["openCi"],
        *ledger["statuses"],
        *(_record(e).get("ruleId") for e in ledger["seen"].values()),
    }:
        if isinstance(rule_id, str) and rule_id not in rule_ids:
            forget_rule(ledger, rule_id)


@dataclass
class Automations:
    """A project's row, read: its valid rules, their owners, the ledger."""

    project_id: str
    rules: list[dict[str, Any]] = field(default_factory=list)
    owners: dict[str, str] = field(default_factory=dict)
    ledger: dict[str, Any] = field(default_factory=empty_ledger)


async def load(db: AsyncSession, project_id: str) -> Automations:
    row = await db.get(ProjectAutomation, project_id)
    if row is None:
        return Automations(project_id)
    # A rule that no longer passes the checks is not run; it is not guessed at.
    rules = [
        rule
        for rule in (parse_stored_rule(r) for r in (row.rules or []))
        if rule is not None
    ]
    owners = {
        str(k): str(v)
        for k, v in _record(row.owners).items()
        if isinstance(v, str) and any(r["id"] == k for r in rules)
    }
    return Automations(project_id, rules, owners, normalize_ledger(row.ledger))


async def save(
    db: AsyncSession,
    automations: Automations,
    *,
    rules: bool = True,
    ledger: bool = True,
) -> None:
    row = await db.get(ProjectAutomation, automations.project_id)
    if row is None:
        row = ProjectAutomation(
            project_id=automations.project_id, rules=[], owners={}, ledger={}
        )
        db.add(row)
    if rules:
        row.rules = list(automations.rules)
        row.owners = dict(automations.owners)
        flag_modified(row, "rules")
        flag_modified(row, "owners")
    if ledger:
        row.ledger = dict(trim_ledger(automations.ledger))
        flag_modified(row, "ledger")
    await db.commit()
