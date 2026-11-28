"""Who created and launched each card of a server project, and what it spent.

The desktop app shows these on a finished card (``main/task-run-facts.ts``).
On a computer it notes them itself; on a server they are already in the
database, so the board's snapshot (``api.board_snapshot``) adds two files to
each card, computed here and never written to disk:

- ``task_people.json``: ``{version, createdBy?, startedBy?}``, each
  ``{kind: "person", name}``. The creator is the account that created the card
  (``specs_index.created_by``); the launcher, the account that started its
  latest run other than a merge (``agent_runs.started_by``). A name is the
  account's display name now, read at each snapshot: renaming an account
  renames it on every card, and a deleted account (``SET NULL``) leaves the
  card without a name rather than keeping a copy of it.
- ``usage_summary.json``: the totals of the card's ``usage_records`` (tokens,
  cache, price, sessions, sessions estimated because the provider reported
  nothing, the models used most). Totals only: no prompt, no answer, nothing
  about one session.

A card with nothing known gets neither file. Anyone who may read the board
reads them: the board already names who holds a card, and the workspace
views already show what its sessions cost (``shared_features/workspace.py``).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from server.db.models import AgentRun, SpecIndex, UsageRecord, User
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

PEOPLE_FILE = "task_people.json"
USAGE_FILE = "usage_summary.json"
#: The files this module adds to a card of the snapshot, and nothing else.
FACT_FILES = (PEOPLE_FILE, USAGE_FILE)

MAX_NAME = 120
MAX_MODELS = 3
#: A merge is a reviewer's act, not the launch of the card's work.
NOT_A_LAUNCH = frozenset({"merge"})


def _name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = value.strip()[:MAX_NAME]
    if not name or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name):
        return None
    return name


async def _names(db: AsyncSession, ids: Iterable[str | None]) -> dict[str, str]:
    wanted = {i for i in ids if i}
    if not wanted:
        return {}
    rows = await db.execute(
        select(User.id, User.display_name).where(User.id.in_(wanted))
    )
    names: dict[str, str] = {}
    for user_id, display in rows.all():
        name = _name(display)
        if name:
            names[user_id] = name
    return names


async def _launchers(db: AsyncSession, spec_ids: list[str]) -> dict[str, str]:
    """The account that started each card's latest run (merges left out)."""
    if not spec_ids:
        return {}
    rows = await db.execute(
        select(AgentRun.spec_id, AgentRun.started_by)
        .where(
            AgentRun.spec_id.in_(spec_ids),
            AgentRun.started_by.is_not(None),
            AgentRun.phase.not_in(NOT_A_LAUNCH),
        )
        .order_by(AgentRun.started_at.desc())
    )
    latest: dict[str, str] = {}
    for spec_id, started_by in rows.all():
        latest.setdefault(spec_id, started_by)
    return latest


async def _usage(db: AsyncSession, spec_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Each card's usage totals, from the records of its runs."""
    if not spec_ids:
        return {}
    joined = UsageRecord.run_id == AgentRun.id
    totals = await db.execute(
        select(
            AgentRun.spec_id,
            func.sum(UsageRecord.input_tokens),
            func.sum(UsageRecord.output_tokens),
            func.sum(UsageRecord.cache_read_tokens),
            func.sum(UsageRecord.cache_write_tokens),
            func.sum(UsageRecord.cost_micro_usd),
            func.count(UsageRecord.id),
            func.sum(case((UsageRecord.estimated.is_(True), 1), else_=0)),
        )
        .join(AgentRun, joined)
        .where(AgentRun.spec_id.in_(spec_ids))
        .group_by(AgentRun.spec_id)
    )
    out: dict[str, dict[str, Any]] = {}
    for spec_id, inp, outp, cread, cwrite, micro, sessions, estimated in totals.all():
        summary = {
            "inputTokens": int(inp or 0),
            "outputTokens": int(outp or 0),
            "cacheReadTokens": int(cread or 0),
            "cacheWriteTokens": int(cwrite or 0),
            "costUsd": round(int(micro or 0) / 1_000_000, 6),
            "sessions": int(sessions or 0),
            "estimatedSessions": int(estimated or 0),
            "models": [],
        }
        tokens = sum(
            summary[k]
            for k in (
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
            )
        )
        if summary["sessions"] and (tokens or summary["costUsd"]):
            out[spec_id] = summary
    if not out:
        return out
    models = await db.execute(
        select(AgentRun.spec_id, UsageRecord.model, func.count(UsageRecord.id))
        .join(AgentRun, joined)
        .where(AgentRun.spec_id.in_(list(out)), UsageRecord.model != "")
        .group_by(AgentRun.spec_id, UsageRecord.model)
        .order_by(func.count(UsageRecord.id).desc())
    )
    for spec_id, model, _count in models.all():
        name = _name(model)
        listed = out[spec_id]["models"]
        if name and len(listed) < MAX_MODELS:
            listed.append(name)
    return out


async def card_fact_files(
    db: AsyncSession, project_id: str, card_names: Iterable[str]
) -> dict[str, dict[str, str]]:
    """The fact files of each named card of a project, as snapshot files."""
    names = set(card_names)
    if not names:
        return {}
    rows = await db.execute(
        select(SpecIndex.id, SpecIndex.spec_name, SpecIndex.created_by).where(
            SpecIndex.project_id == project_id, SpecIndex.spec_name.in_(names)
        )
    )
    index = {
        spec_id: (spec_name, created_by)
        for spec_id, spec_name, created_by in rows.all()
    }
    spec_ids = list(index)
    launchers = await _launchers(db, spec_ids)
    usage = await _usage(db, spec_ids)
    people_names = await _names(
        db, [created for _n, created in index.values()] + list(launchers.values())
    )

    files: dict[str, dict[str, str]] = {}
    for spec_id, (card, created_by) in index.items():
        card_files: dict[str, str] = {}
        people: dict[str, Any] = {}
        creator = people_names.get(created_by or "")
        if creator:
            people["createdBy"] = {"kind": "person", "name": creator}
        launcher = people_names.get(launchers.get(spec_id, ""))
        if launcher:
            people["startedBy"] = {"kind": "person", "name": launcher}
        if people:
            card_files[PEOPLE_FILE] = json.dumps({"version": 1, **people})
        if spec_id in usage:
            card_files[USAGE_FILE] = json.dumps({"version": 1, **usage[spec_id]})
        if card_files:
            files[card] = card_files
    return files
