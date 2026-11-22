"""The lifecycle of a server project's memory: its journal, trash, pins and undo.

On the desktop the Lifecycle tab reads the person's brain
(``brain/lifecycle/api.py``). A server project's memory is its own brain
(``run_isolation.project_brain``), which every run of the project learns into
and every member reads (``shared_features.context``); these routes serve the
same decisions on it, with the server's permissions:

| Route | Permission |
|---|---|
| ``GET /lifecycle`` · ``GET /history`` | ``insight.read``: every member reads why a memory went |
| ``POST /forget`` · ``/restore`` · ``/pin`` · ``/scope`` · ``/revert`` | ``insight.write`` |

The memory is the team's, so a decision on it is the team's too: whoever
may write the project's insights (a contributor, an analyst, a maintainer,
an administrator) may forget, pin, restore or take back an automatic
decision, and the journal names them (``by``, their display name; the e-mail
is never written). A viewer reads the journal and decides nothing.

The conflict queue, its maintainers and the model's opinion stay on the
desktop: they follow a git sync between teammates' vaults, and a server
project's brain is never synced, its runs write it on the server itself.

A route takes a ``project_id`` (``resolve_project_scope``), never a path; a
memory is named by its vault path and checked by ``store.memory_rel`` before
anything is opened. The brain is the project's runs' to write, so no git
command is run in it (the person comes from the session, `identity.acting_as`),
a brain that leads out of the project's home is refused, and what a run wrote
is passed through ``redact_text`` before it is served.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.config import get_settings
from server.services.run_isolation import project_brain, project_home

router = APIRouter(prefix="/api/features/context/memory", tags=["features"])

MAX_ID = 400
MAX_REASON = 300
MAX_SCOPE = 200
MAX_LIMIT = 500
_ENTRY_ID = r"^[0-9a-f]{12}$"

_INVALID = {"success": False, "error": "invalid", "code": "invalid"}
_NO_BRAIN = {"success": False, "error": "no-brain", "code": "no-brain"}


class MemoryBody(BaseModel):
    id: str = Field(default="", max_length=MAX_ID)


class ForgetBody(MemoryBody):
    reason: str = Field(default="", max_length=MAX_REASON)


class PinBody(MemoryBody):
    pinned: bool = True


class ScopeBody(MemoryBody):
    applies_to: str = Field(default="", max_length=MAX_SCOPE)


class RevertBody(BaseModel):
    entry_id: str = Field(default="", pattern=_ENTRY_ID)


def brain_root(scope: ProjectScope) -> Path | None:
    """The project's brain, when it exists and stays in the project's home.

    A run writes its project's home: a brain it replaced by a link to
    another directory is not this project's memory.
    """
    from brain.home import is_brain

    repos = get_settings().repos_root
    root = project_brain(repos, scope.project_id)
    home = project_home(repos, scope.project_id).resolve()
    if not root.resolve().is_relative_to(home) or not is_brain(root):
        return None
    return root


def _base(scope: ProjectScope) -> Path:
    from brain.lifecycle.store import memory_base
    from brain.tasks import project_name_from

    # The name a build of this clone files its notes under.
    return memory_base(project_name_from(str(scope.path)))


def _redacted(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from foundation.log_redaction import redact_text

    return [
        {
            key: redact_text(value) if isinstance(value, str) else value
            for key, value in row.items()
        }
        for row in rows
    ]


def _person(principal: Principal) -> tuple[str, str]:
    return principal.display_name.strip(), principal.email.strip()


def _answer(outcome: dict[str, Any]) -> dict[str, Any]:
    ok = bool(outcome.pop("ok", False))
    if ok:
        return {"success": True, **outcome}
    code = str(outcome.get("code") or "failed")
    return {"success": False, "error": code, **outcome}


def read_lifecycle(scope: ProjectScope, limit: int) -> dict[str, Any]:
    """The journal, what can be taken back, the figures, the trash and the pins."""
    from brain.lifecycle import journal, metrics, store, undo

    root = brain_root(scope)
    if root is None:
        return dict(_NO_BRAIN)
    base = _base(scope)
    store.purge_expired(root, base)
    entries = journal.read(root, base, limit=5000)
    modes = undo.revertible(root, base, entries)
    return {
        "success": True,
        "journal": _redacted([e.to_dict() for e in entries[:limit]]),
        "revertible": modes,
        "last_undo": undo.last_undo(entries, modes),
        "metrics": metrics.compute(root, base, entries),
        "trash": _redacted(store.trash(root, base)),
        # No sync, so no teammate's note to contradict (see the module).
        "conflicts": [],
        "maintainers": [],
        "can_arbitrate": False,
        "pinned": store.pinned_count(root, base),
        "pin_limit": store.PIN_LIMIT,
        "retention_days": store.retention_days(),
    }


def read_history(scope: ProjectScope, memory_id: str, limit: int) -> dict[str, Any]:
    from brain.lifecycle import journal, metrics, store

    root = brain_root(scope)
    if root is None:
        return dict(_NO_BRAIN)
    base = _base(scope)
    try:
        rel = store.memory_rel(base, memory_id)
    except ValueError:
        return dict(_INVALID)
    entries = journal.read(root, base, note=rel, limit=limit)
    metrics.count_view(root, base)
    return {
        "success": True,
        "id": rel,
        "entries": _redacted([e.to_dict() for e in entries]),
    }


def decide(scope: ProjectScope, principal: Principal, action: str, **args: Any) -> dict:
    """One person's decision on the project's memory, in their name."""
    from brain.lifecycle import identity, store, undo

    root = brain_root(scope)
    if root is None:
        return dict(_NO_BRAIN)
    base = _base(scope)
    name, email = _person(principal)
    with identity.acting_as(name, email):
        try:
            if action == "forget":
                outcome = store.forget(
                    root,
                    base,
                    args["id"],
                    actor="user",
                    reason_code="user-request",
                    reason=args["reason"],
                )
            elif action == "restore":
                outcome = store.restore(root, base, args["id"], actor="user")
            elif action == "pin":
                outcome = store.pin(
                    root, base, args["id"], args["pinned"], actor="user"
                )
            elif action == "scope":
                outcome = store.scope(root, base, args["id"], args["applies_to"])
            else:
                outcome = undo.revert(root, base, args["entry_id"], actor="user")
        except ValueError:
            return dict(_INVALID)
    return _answer(outcome)


@router.get("/lifecycle")
async def lifecycle(
    limit: int = Query(default=100, ge=1, le=MAX_LIMIT),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(read_lifecycle, scope, limit)


@router.get("/history")
async def history(
    id: str = Query(default="", max_length=MAX_ID),
    limit: int = Query(default=100, ge=1, le=MAX_LIMIT),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(read_history, scope, id, limit)


@router.post("/forget")
async def forget(
    body: ForgetBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        decide, scope, get_principal(request), "forget", id=body.id, reason=body.reason
    )


@router.post("/restore")
async def restore(
    body: MemoryBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        decide, scope, get_principal(request), "restore", id=body.id
    )


@router.post("/pin")
async def pin(
    body: PinBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        decide, scope, get_principal(request), "pin", id=body.id, pinned=body.pinned
    )


@router.post("/scope")
async def set_scope(
    body: ScopeBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        decide,
        scope,
        get_principal(request),
        "scope",
        id=body.id,
        applies_to=body.applies_to,
    )


@router.post("/revert")
async def revert(
    body: RevertBody,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    return await asyncio.to_thread(
        decide, scope, get_principal(request), "revert", entry_id=body.entry_id
    )
