"""``/api/brain/memory/*`` — the memory's journal, trash, pins and conflicts.

Included in the brain's router (`brain.api`), so it is refused in server mode
like the rest of it: the brain lives in the home directory of the machine
running the backend.

| Route | Answers |
|---|---|
| ``GET /lifecycle`` | the journal, the trash (and what it purges within 7 days), the conflict queue, the pins |
| ``GET /history`` | one memory's timeline |
| ``POST /forget`` · ``/restore`` · ``/pin`` | a person's decision on one memory |
| ``POST /revert`` | undo an automatic decision of the last hour, or separate a merge (`undo.py`) |
| ``POST /scope`` | where one memory applies (``applies_to``) |
| ``POST /maintainers`` | who settles an escalated conflict (`maintainers.py`) |
| ``POST /conflicts/resolve`` | keep A, keep B, write the canonical note, or "not a conflict" |
| ``POST /conflicts/suggest`` | a model's opinion on one queued pair (`advisor.py`) |

The project is a *name* read out of ``project_dir``, never a directory opened
(as for ``/memories``); a memory is named by its vault path and checked by
`store.memory_rel` before anything is read. Only ``/conflicts/suggest`` opens
the project's directory — `validated_dir` — so that its offline policy is the
one the model call obeys.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from foundation.api_safety import server_mode_roots, validated_dir
from pydantic import BaseModel

from ..tasks import project_name_from
from ..vault import Brain
from . import (
    arbitration,
    folds,
    identity,
    journal,
    maintainers,
    metrics,
    store,
    undo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/memory", tags=["brain"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "the shared brain is a desktop feature",
    "reason": "server-mode",
}
_MAX_REASON = 300


class MemoryRequest(BaseModel):
    project_dir: str = ""
    id: str = ""
    reason: str = ""
    pinned: bool = True


class ConflictRequest(BaseModel):
    project_dir: str = ""
    conflict_id: str = ""
    choice: str = ""
    text: str = ""


def _scope(project_dir: str) -> tuple[Brain, Path] | dict[str, Any]:
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    project = project_name_from(project_dir or "")
    if not project:
        return {"success": False, "error": "project_dir is required", "code": "invalid"}
    brain = Brain()
    if not brain.exists:
        return {"success": False, "error": "no brain yet", "code": "no-brain"}
    return brain, store.memory_base(project)


def _sync(brain: Brain, message: str) -> None:
    try:
        brain.after_write(message)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        # The decision is on disk; the next sync carries it.
        logger.warning("brain: sync after a memory decision failed: %s", exc)


def _answer(outcome: dict[str, Any]) -> dict[str, Any]:
    ok = bool(outcome.pop("ok", False))
    if ok:
        return {"success": True, **outcome}
    code = str(outcome.get("code") or "failed")
    return {"success": False, "error": code, **outcome}


@router.get("/lifecycle")
def lifecycle(project_dir: str = "", limit: int = 100) -> dict:
    scope = _scope(project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    purged = store.purge_expired(brain.root, base)
    purged += folds.purge_expired(brain.root, base)
    if purged:
        _sync(brain, f"brain: purge {purged} forgotten memory note(s)")
    limit = max(1, min(int(limit or 100), 500))
    # Every month of the journal: the figures span 30 days and an undo names
    # an entry that may be older than the page shown.
    entries = journal.read(brain.root, base, limit=5000)
    modes = undo.revertible(brain.root, base, entries)
    return {
        "success": True,
        "journal": [e.to_dict() for e in entries[:limit]],
        "revertible": modes,
        "last_undo": undo.last_undo(entries, modes),
        "metrics": metrics.compute(brain.root, base, entries),
        "trash": store.trash(brain.root, base),
        "conflicts": arbitration.open_conflicts(brain.root, base.as_posix()),
        "maintainers": (names := maintainers.read(brain.root, base)),
        "can_arbitrate": maintainers.allows(names, identity.person(brain.root)),
        "pinned": store.pinned_count(brain.root, base),
        "pin_limit": store.PIN_LIMIT,
        "retention_days": store.retention_days(),
    }


@router.get("/history")
def history(project_dir: str = "", id: str = "", limit: int = 100) -> dict:
    scope = _scope(project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    try:
        rel = store.memory_rel(base, id)
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    limit = max(1, min(int(limit or 100), 500))
    entries = journal.read(brain.root, base, note=rel, limit=limit)
    metrics.count_view(brain.root, base)
    return {"success": True, "id": rel, "entries": [e.to_dict() for e in entries]}


@router.post("/forget")
def forget(request: MemoryRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    try:
        outcome = store.forget(
            brain.root,
            base,
            request.id,
            actor="user",
            reason_code="user-request",
            reason=request.reason[:_MAX_REASON],
        )
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    if outcome.get("ok"):
        _sync(brain, "brain: forget a memory note")
    return _answer(outcome)


@router.post("/restore")
def restore(request: MemoryRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    try:
        outcome = store.restore(brain.root, base, request.id, actor="user")
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    if outcome.get("ok"):
        _sync(brain, "brain: restore a memory note")
    return _answer(outcome)


@router.post("/pin")
def pin(request: MemoryRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    try:
        outcome = store.pin(brain.root, base, request.id, request.pinned, actor="user")
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    if outcome.get("ok"):
        _sync(
            brain,
            "brain: pin a memory note"
            if request.pinned
            else "brain: unpin a memory note",
        )
    return _answer(outcome)


class ScopeRequest(BaseModel):
    project_dir: str = ""
    id: str = ""
    applies_to: str = ""


@router.post("/scope")
def set_scope(request: ScopeRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    try:
        outcome = store.scope(brain.root, base, request.id, request.applies_to)
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    if outcome.get("ok"):
        _sync(brain, "brain: scope a memory note")
    return _answer(outcome)


class MaintainersRequest(BaseModel):
    project_dir: str = ""
    names: list[str] = []


@router.post("/maintainers")
def set_maintainers(request: MaintainersRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    kept = maintainers.write(brain.root, base, request.names)
    if kept is None:
        return {"success": False, "error": "invalid", "code": "invalid"}
    _sync(brain, "brain: designate the memory maintainers")
    return {"success": True, "maintainers": kept}


class RevertRequest(BaseModel):
    project_dir: str = ""
    entry_id: str = ""


@router.post("/revert")
def revert(request: RevertRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    outcome = undo.revert(brain.root, base, request.entry_id[:40], actor="user")
    if outcome.get("ok"):
        _sync(brain, "brain: take a memory decision back")
    return _answer(outcome)


def _queued(brain: Brain, base: Path, conflict_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in arbitration.open_conflicts(brain.root, base.as_posix())
            if item.get("id") == conflict_id
        ),
        None,
    )


@router.post("/conflicts/resolve")
def resolve_conflict(request: ConflictRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    if _queued(brain, base, request.conflict_id) is None:
        return {"success": False, "error": "not-found", "code": "not-found"}
    outcome = arbitration.resolve(
        brain.root, request.conflict_id, request.choice, request.text, actor="user"
    )
    if outcome.get("ok"):
        _sync(brain, "brain: resolve a memory conflict")
    return _answer(outcome)


@router.post("/conflicts/suggest")
async def suggest_resolution(request: ConflictRequest) -> dict:
    scope = _scope(request.project_dir)
    if isinstance(scope, dict):
        return scope
    brain, base = scope
    entry = _queued(brain, base, request.conflict_id)
    if entry is None:
        return {"success": False, "error": "not-found", "code": "not-found"}
    try:
        project = validated_dir(request.project_dir, "project_dir")
    except ValueError:
        return {"success": False, "error": "invalid", "code": "invalid"}
    from .advisor import suggest

    return _answer(await suggest(entry, project_dir=str(project)))
