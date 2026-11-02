"""The automations of a server project: its rules, shared by the team, what
they did, and a pass on demand.

Every route takes a ``project_id``, never a path, resolved through
``server.authz.scope``. The router is mounted as part of the board (the
``task`` domain): reading the rules needs ``task.read`` and a role on the
project; saving, deleting or running them ``task.write`` and the member role.
A rule that starts agents (a build, a review) also needs ``agent.execute``
of whoever saves it. Whoever saves a rule becomes its owner: the rule reads
the forge with their token from then on, which the panel shows.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import AuditLog, User
from shared_board.cards import _require_writer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .cards import engine_metadata
from .live import needs_execute
from .rules import MAX_RULES, RuleError, is_rule_id, parse_rule
from .scheduler import get_scheduler, lifespan
from .store import Automations, forget_rule, load, project_lock, save

router = APIRouter(prefix="/api/board/automations", tags=["board"], lifespan=lifespan)


async def _state(db: AsyncSession, automations: Automations) -> dict[str, Any]:
    """What the panel shows: the rules, their status, the latest activity
    first, and whose tokens each rule runs with (a name, never a token)."""
    ids = {rule["id"] for rule in automations.rules}
    owner_ids = set(automations.owners.values())
    names: dict[str, str] = {}
    if owner_ids:
        rows = await db.execute(
            select(User.id, User.display_name).where(User.id.in_(owner_ids))
        )
        names = {user_id: name for user_id, name in rows}
    ledger = automations.ledger
    return {
        "rules": automations.rules,
        "statuses": {k: v for k, v in ledger["statuses"].items() if k in ids},
        "activity": list(reversed(ledger["activity"])),
        "owners": {
            rule_id: names[user_id]
            for rule_id, user_id in automations.owners.items()
            if user_id in names
        },
        "runsOn": "server",
    }


@router.get("")
async def get_automations(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await _state(db, await load(db, scope.project_id))


@router.post("/rules")
async def save_rule(
    request: Request,
    raw: dict[str, Any] = Body(...),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Add a rule, or change the one ``id`` names; the caller becomes its owner."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    async with project_lock(scope.project_id):
        automations = await load(db, scope.project_id)
        rule_id = raw.get("id")
        existing = None
        if rule_id is not None:
            existing = next(
                (
                    r
                    for r in automations.rules
                    if is_rule_id(rule_id) and r["id"] == rule_id
                ),
                None,
            )
            if existing is None:
                raise HTTPException(status_code=404, detail="Unknown rule")
        elif len(automations.rules) >= MAX_RULES:
            raise HTTPException(
                status_code=409, detail=f"A project has at most {MAX_RULES} rules"
            )
        try:
            rule = parse_rule(raw, existing)
        except RuleError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        if rule.get("engine"):
            try:
                engine_metadata(rule["engine"])
            except ValueError as e:
                raise HTTPException(
                    status_code=422,
                    detail="The engine's provider is not one this server runs",
                ) from e
        if needs_execute(rule) and not principal.has("agent.execute"):
            raise HTTPException(
                status_code=403, detail="Missing permission: agent.execute"
            )
        automations.rules = (
            [rule if r["id"] == rule["id"] else r for r in automations.rules]
            if existing
            else [*automations.rules, rule]
        )
        automations.owners[rule["id"]] = principal.id
        db.add(
            AuditLog(
                user_id=principal.id,
                org_id=scope.org_id,
                project_id=scope.project_id,
                action="automation.rule.saved",
                payload={
                    "rule": rule["id"],
                    "name": rule["name"],
                    "trigger": rule["trigger"]["type"],
                    "enabled": rule["enabled"],
                    "draft": rule["draft"],
                },
            )
        )
        await save(db, automations, ledger=False)
    return await _state(db, automations)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Delete a rule and forget what it did."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    async with project_lock(scope.project_id):
        automations = await load(db, scope.project_id)
        if not is_rule_id(rule_id) or not any(
            r["id"] == rule_id for r in automations.rules
        ):
            raise HTTPException(status_code=404, detail="Unknown rule")
        automations.rules = [r for r in automations.rules if r["id"] != rule_id]
        automations.owners.pop(rule_id, None)
        forget_rule(automations.ledger, rule_id)
        db.add(
            AuditLog(
                user_id=principal.id,
                org_id=scope.org_id,
                project_id=scope.project_id,
                action="automation.rule.deleted",
                payload={"rule": rule_id},
            )
        )
        await save(db, automations)
    return await _state(db, automations)


@router.post("/run")
async def run_now(
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A pass now, joined with the one running if any; each rule still acts
    as its owner, whoever asks."""
    _require_writer(scope, get_principal(request))
    await get_scheduler().run(scope.project_id)
    db.expire_all()
    return await _state(db, await load(db, scope.project_id))
